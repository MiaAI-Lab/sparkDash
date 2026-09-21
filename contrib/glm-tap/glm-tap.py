#!/usr/bin/env python3
"""glm-tap — passive-fidelity request tap for the GLM brain (F717, 2026-09-19).

Byte-level TCP relay: LISTEN :8889 → 127.0.0.1:8888. Every byte is forwarded exactly as received in
both directions (no header rewriting, no buffering of the stream), so HTTP/SSE semantics are the
engine's own. On the side it parses each request (head + Content-Length body) and, for
/v1/chat/completions, records what the engine was actually asked: model, message count, the last
user message (truncated), thinking/effort flags, and then the live response: SSE chunk count
(≈ output tokens), finish reason, usage if present, wall time, tokens/s.
A second listener on :8890 serves the ring buffer as JSON for sparkDash:
  GET /recent   → {"active":[...], "recent":[...], "stats":{...}}
Traffic reaches :8889 via an iptables PREROUTING REDIRECT (managed by the systemd unit); loopback
clients bypass the tap. If this process dies, the unit's ExecStopPost removes the rule → direct.
"""
import asyncio, json, time, os, re, collections, signal, sys

UPSTREAM = (os.environ.get("TAP_UPSTREAM_HOST", "127.0.0.1"), int(os.environ.get("TAP_UPSTREAM_PORT", "8888")))
LISTEN_PORT = int(os.environ.get("TAP_LISTEN_PORT", "8889"))
API_PORT = int(os.environ.get("TAP_API_PORT", "8890"))
MAX_BODY_KEEP = 8 * 1024 * 1024       # parse bodies up to 8 MB (a 300k-token prompt ≈ 1.2 MB)
PREVIEW = int(os.environ.get("TAP_PREVIEW_CHARS", "600"))
RING = collections.deque(maxlen=300)
ACTIVE = {}
TRANSCRIPTS = collections.OrderedDict()          # id -> list of {role, text, ...}; last TRANSCRIPT_KEEP requests
TRANSCRIPT_KEEP = int(os.environ.get("TAP_TRANSCRIPT_KEEP", "80"))
TRANSCRIPT_MSG_CHARS = int(os.environ.get("TAP_TRANSCRIPT_MSG_CHARS", "6000"))
STATS = {"requests": 0, "chat": 0, "bytes_in": 0, "bytes_out": 0, "started": time.time(), "errors": 0}
_seq = 0

def _txt(m):
    c = m.get("content")
    if isinstance(c, str): return c
    if isinstance(c, list):
        return " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text") or "[non-text content]"
    return ""

def summarize_request(path, body, client):
    global _seq
    _seq += 1
    rec = {"id": _seq, "t0": time.time(), "client": client, "path": path, "status": "prefill", "chunks": 0,
           "out_tokens": None, "finish": None, "t_first": None, "t_end": None, "req_bytes": len(body)}
    try:
        j = json.loads(body)
        msgs = j.get("messages") or []
        rec.update({"model": j.get("model"), "stream": bool(j.get("stream")), "n_messages": len(msgs),
                    "max_tokens": j.get("max_tokens") or j.get("max_completion_tokens"),
                    "tools": len(j.get("tools") or []),
                    "thinking": (j.get("chat_template_kwargs") or {}).get("enable_thinking",
                                (j.get("chat_template_kwargs") or {}).get("thinking")),
                    "effort": j.get("reasoning_effort") or (j.get("chat_template_kwargs") or {}).get("reasoning_effort"),
                    "temperature": j.get("temperature"), "prompt_chars": sum(len(_txt(m)) for m in msgs)})
        sysm = next((m for m in msgs if m.get("role") == "system"), None)
        rec["system_chars"] = len(_txt(sysm)) if sysm else 0
        rec["system_preview"] = (_txt(sysm)[:160] if sysm else "")
        last_user = next((m for m in reversed(msgs) if m.get("role") == "user"), None)
        last_any = msgs[-1] if msgs else None
        rec["last_user"] = _txt(last_user)[-PREVIEW:] if last_user else ""
        rec["last_role"] = last_any.get("role") if last_any else None
        if last_any and last_any.get("role") == "tool":
            rec["last_tool_result"] = _txt(last_any)[:200]
        rec["n_tool_results"] = sum(1 for m in msgs if m.get("role") == "tool")
        # F720: keep the conversation this request carried (its own history) for the full-screen view
        tr = []
        for m in msgs:
            t = _txt(m); item = {"role": m.get("role"), "chars": len(t), "text": t[:TRANSCRIPT_MSG_CHARS]}
            if m.get("name"): item["name"] = m["name"]
            if m.get("tool_call_id"): item["tool_call_id"] = m["tool_call_id"]
            tcs = m.get("tool_calls") or []
            if tcs: item["tool_calls"] = [{"name": (c.get("function") or {}).get("name"), "args": ((c.get("function") or {}).get("arguments") or "")[:1500]} for c in tcs]
            rc = m.get("reasoning_content") or m.get("reasoning")
            if isinstance(rc, str) and rc: item["reasoning"] = rc[:2000]
            tr.append(item)
        TRANSCRIPTS[rec["id"]] = tr
        while len(TRANSCRIPTS) > TRANSCRIPT_KEEP: TRANSCRIPTS.popitem(last=False)
    except Exception as e:
        rec["parse_error"] = str(e)[:120]
    return rec

class ReqParser:
    """Incremental HTTP/1.1 request parser over a byte stream (keep-alive aware)."""
    def __init__(self): self.buf = b""; self.head = None; self.need = 0; self.body = b""; self.chunked = False
    def feed(self, data):
        out = []
        self.buf += data
        while True:
            if self.head is None:
                i = self.buf.find(b"\r\n\r\n")
                if i < 0: return out
                raw = self.buf[:i].decode("latin-1", "replace"); self.buf = self.buf[i+4:]
                lines = raw.split("\r\n"); req = lines[0].split(" ")
                hdr = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
                self.head = (req[0] if req else "?", req[1] if len(req) > 1 else "?", hdr)
                self.chunked = "chunked" in hdr.get("transfer-encoding", "").lower()
                self.need = int(hdr.get("content-length", "0") or 0); self.body = b""
            if self.chunked:      # rare for our clients; do not parse, just resync at next request head
                out.append((self.head, None)); self.head = None; self.buf = b""; return out
            take = min(self.need, len(self.buf))   # need = bytes still owed (F719 fix: was double-subtracting body length)
            if len(self.body) < MAX_BODY_KEEP: self.body += self.buf[:take]
            self.buf = self.buf[take:]; self.need -= take
            if self.need > 0: return out
            out.append((self.head, self.body)); self.head = None

async def pump_client_to_upstream(reader, writer, state, client):
    p = ReqParser()
    try:
        while True:
            data = await reader.read(65536)
            if not data: break
            STATS["bytes_in"] += len(data)
            writer.write(data); await writer.drain()
            for (method, path, hdr), body in p.feed(data):
                STATS["requests"] += 1
                if method == "POST" and path.startswith("/v1/chat/completions") and body is not None:
                    STATS["chat"] += 1
                    rec = summarize_request(path, body, client)
                    state["queue"].append(rec); ACTIVE[rec["id"]] = rec
    except Exception as e:
        STATS["errors"] += 1; print("c2u error:", repr(e), flush=True)
    finally:
        try: writer.write_eof()
        except Exception: pass

TEXT_KEEP = int(os.environ.get("TAP_TEXT_KEEP", "24000"))   # chars of output/reasoning kept per request

class RespDecoder:
    """Decode an HTTP/1.1 response body stream (chunked or content-length) into body bytes; one response at a time."""
    def __init__(self): self.reset()
    def reset(self): self.buf = b""; self.head = None; self.chunked = False; self.remaining = None; self.chunk_left = 0; self.done = False
    def feed(self, data):
        """Returns (body_bytes, response_complete)."""
        self.buf += data; out = b""
        if self.head is None:
            i = self.buf.find(b"\r\n\r\n")
            if i < 0: return b"", False
            raw = self.buf[:i].decode("latin-1", "replace"); self.buf = self.buf[i+4:]
            hdr = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in raw.split("\r\n")[1:] if ":" in l)}
            self.head = raw.split("\r\n")[0]; self.chunked = "chunked" in hdr.get("transfer-encoding", "").lower()
            self.remaining = int(hdr.get("content-length", "0") or 0) if not self.chunked else None
        if self.chunked:
            while True:
                if self.chunk_left == 0:
                    j = self.buf.find(b"\r\n")
                    if j < 0: return out, False
                    try: n = int(self.buf[:j].split(b";")[0].strip() or b"0", 16)
                    except ValueError: n = 0
                    self.buf = self.buf[j+2:]
                    if n == 0:
                        self.done = True; self.buf = b""; return out, True
                    self.chunk_left = n
                take = min(self.chunk_left, len(self.buf))
                out += self.buf[:take]; self.buf = self.buf[take:]; self.chunk_left -= take
                if self.chunk_left == 0 and len(self.buf) >= 2: self.buf = self.buf[2:]   # trailing CRLF
                elif self.chunk_left == 0: return out, False
                if not self.buf: return out, False
        else:
            take = min(self.remaining or 0, len(self.buf)); out += self.buf[:take]; self.buf = self.buf[take:]
            self.remaining = (self.remaining or 0) - take
            return out, (self.remaining or 0) <= 0

def _append(rec, key, text):
    if not text: return
    cur = rec.get(key) or ""
    rec[key + "_len"] = rec.get(key + "_len", 0) + len(text)
    cur += text
    if len(cur) > TEXT_KEEP: cur = cur[-TEXT_KEEP:]
    rec[key] = cur

def _apply_sse(rec, line):
    """One SSE line (b'data: {...}')."""
    if not line.startswith(b"data:"): return
    payload = line[5:].strip()
    if payload == b"[DONE]": return
    try: j = json.loads(payload)
    except Exception: return
    ch = (j.get("choices") or [None])[0] or {}
    d = ch.get("delta") or {}
    _append(rec, "out_text", d.get("content") or "")
    _append(rec, "reasoning_text", d.get("reasoning_content") or d.get("reasoning") or "")
    for tc in d.get("tool_calls") or []:
        f = tc.get("function") or {}
        if f.get("name"): _append(rec, "out_text", "\n⚙ tool_call %s(" % f["name"])
        if f.get("arguments"): _append(rec, "out_text", f["arguments"])
    if ch.get("finish_reason"): rec["finish"] = ch["finish_reason"]
    u = j.get("usage")
    if u and u.get("completion_tokens") is not None: rec["out_tokens"] = u["completion_tokens"]
    if u and u.get("prompt_tokens") is not None: rec["prompt_tokens"] = u["prompt_tokens"]
    rec["chunks"] += 1

def _apply_json(rec, body):
    try: j = json.loads(body)
    except Exception: return
    ch = (j.get("choices") or [None])[0] or {}; m = ch.get("message") or {}
    _append(rec, "out_text", m.get("content") or "")
    _append(rec, "reasoning_text", m.get("reasoning_content") or m.get("reasoning") or "")
    for tc in m.get("tool_calls") or []:
        f = tc.get("function") or {}; _append(rec, "out_text", "\n⚙ tool_call %s(%s)" % (f.get("name"), f.get("arguments", "")))
    if ch.get("finish_reason"): rec["finish"] = ch["finish_reason"]
    u = j.get("usage") or {}
    if u.get("completion_tokens") is not None: rec["out_tokens"] = u["completion_tokens"]
    if u.get("prompt_tokens") is not None: rec["prompt_tokens"] = u["prompt_tokens"]
    if j.get("error"): rec["error"] = str(j["error"])[:300]

async def pump_upstream_to_client(reader, writer, state):
    """Relay response bytes unchanged; decode a copy to follow the in-flight chat request."""
    cur = None; dec = RespDecoder(); linebuf = b""; jsonbuf = b""
    try:
        while True:
            data = await reader.read(65536)
            if not data: break
            STATS["bytes_out"] += len(data)
            writer.write(data); await writer.drain()
            if cur is None and state["queue"]:
                cur = state["queue"].popleft(); cur["status"] = "streaming"; dec.reset(); linebuf = b""; jsonbuf = b""
            if cur is None: continue
            body, complete = dec.feed(data)
            if dec.head and cur.get("http") is None: cur["http"] = dec.head
            if cur.get("stream"):
                if body and cur.get("t_first") is None: cur["t_first"] = time.time()
                linebuf += body
                while b"\n" in linebuf:
                    line, linebuf = linebuf.split(b"\n", 1); _apply_sse(cur, line.strip())
                    if len(linebuf) > 2_000_000: linebuf = linebuf[-65536:]
            else:
                if body and cur.get("t_first") is None: cur["t_first"] = time.time()
                jsonbuf += body
                if len(jsonbuf) > 8_000_000: jsonbuf = jsonbuf[-65536:]
            if complete:
                if not cur.get("stream"): _apply_json(cur, jsonbuf)
                _finish(cur); cur = None; dec.reset(); linebuf = b""; jsonbuf = b""
    except Exception as e:
        STATS["errors"] += 1; print("u2c error:", repr(e), flush=True)
    finally:
        if cur is not None: cur["status"] = "disconnected"; _finish(cur)
        try: writer.close()
        except Exception: pass

PREFILL_WIN = collections.deque()   # (t_first_or_end, prompt_tokens) for the rolling prefill-throughput figure

def _finish(rec):
    rec["t_end"] = time.time()
    pt = rec.get("prompt_tokens")
    if pt is None and rec.get("prompt_chars"): pt = int(rec["prompt_chars"] / 3.8); rec["prompt_tokens_est"] = True
    # Settle the final status FIRST (the prefill figure below keys off it): only a request
    # that actually finished counts — aborted/disconnected ones produce the 141k-tok/s artefact.
    if rec.get("status") not in ("disconnected", "aborted"): rec["status"] = "done"
    ok = rec["status"] == "done" and (rec.get("t_first") is not None or not rec.get("stream"))
    if pt and ok:
        # streams: prompt was read by first token; non-stream: by the end minus the decode time (≈ out_tokens / 20 tok/s)
        t_pref_end = rec.get("t_first") if rec.get("stream") and rec.get("t_first") else rec["t_end"]
        dur = max(0.05, (t_pref_end - rec["t0"]) - (0 if rec.get("stream") else (rec.get("out_tokens") or 0) / 20.0))
        rec["prefill_tok_s"] = round(pt / dur)
        PREFILL_WIN.append((t_pref_end, pt))
    if rec.get("out_tokens") is None and rec.get("stream"): rec["out_tokens"] = max(0, rec["chunks"] - 1)
    if rec.get("stream") and rec.get("t_first") and rec.get("out_tokens"):
        dt = rec["t_end"] - rec["t_first"]
        rec["tok_s"] = round(rec["out_tokens"] / dt, 1) if dt > 0 else None
    rec["ttft"] = round(rec["t_first"] - rec["t0"], 2) if rec.get("t_first") else None
    rec["wall"] = round(rec["t_end"] - rec["t0"], 1)
    ACTIVE.pop(rec["id"], None); RING.appendleft(rec)

async def handle_client(reader, writer):
    peer = writer.get_extra_info("peername"); client = peer[0] if peer else "?"
    try:
        ur, uw = await asyncio.open_connection(*UPSTREAM)
    except Exception:
        STATS["errors"] += 1; writer.close(); return
    state = {"queue": collections.deque()}
    await asyncio.gather(pump_client_to_upstream(reader, uw, state, client),
                         pump_upstream_to_client(ur, writer, state))
    for rec in state["queue"]:          # requests that never got a response byte
        rec["status"] = "aborted"; _finish(rec)

async def api(reader, writer):
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
        path = head.split(b" ")[1].decode() if b" " in head else "/"
        if path.startswith("/recent") or path == "/":
            now = time.time()
            active = sorted(ACTIVE.values(), key=lambda r: r["t0"])
            for r in active:
                r["elapsed"] = round(now - r["t0"], 1)
                if r.get("t_first") and r["chunks"]: r["tok_s_live"] = round((r["chunks"]-1) / max(0.001, now - r["t_first"]), 1)
            tail = int(_q(path, "tail", 4000))
            def slim(r):
                r = dict(r)
                for k in ("out_text", "reasoning_text"):
                    if r.get(k) and len(r[k]) > tail: r[k] = r[k][-tail:]
                return r
            while PREFILL_WIN and PREFILL_WIN[0][0] < now - 60: PREFILL_WIN.popleft()
            pref60 = round(sum(p for _, p in PREFILL_WIN) / 60.0)
            body = json.dumps({"now": now, "active": [slim(r) for r in active], "recent": [slim(r) for r in list(RING)[:int(_q(path, "n", 60))]],
                               "stats": {**STATS, "uptime": round(now - STATS["started"]), "prefill_tok_s_60s": pref60, "prefill_requests_60s": len(PREFILL_WIN)}}, default=str).encode()
            resp = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body
        elif path.startswith("/req/"):
            rid = int(re.search(r"/req/(\d+)", path).group(1))
            rec = ACTIVE.get(rid) or next((r for r in RING if r["id"] == rid), None)
            if rec:
                rec = dict(rec); rec["transcript"] = TRANSCRIPTS.get(rid); rec["now"] = time.time()
                if rec.get("t_first") and rec.get("status") in ("streaming", "prefill") and rec["chunks"]:
                    rec["tok_s_live"] = round((rec["chunks"] - 1) / max(0.001, time.time() - rec["t_first"]), 1)
                rec["elapsed"] = round(time.time() - rec["t0"], 1)
            body = json.dumps(rec or {"error": "not found"}, default=str).encode()
            resp = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body
        elif path.startswith("/health"):
            resp = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
        else:
            resp = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        writer.write(resp); await writer.drain()
    except Exception:
        pass
    finally:
        writer.close()

def _q(path, key, default):
    m = re.search(r"[?&]" + key + r"=(\d+)", path); return int(m.group(1)) if m else default

async def main():
    s1 = await asyncio.start_server(handle_client, "0.0.0.0", LISTEN_PORT, backlog=256)
    s2 = await asyncio.start_server(api, "0.0.0.0", API_PORT)
    print(f"glm-tap: relay :{LISTEN_PORT} -> {UPSTREAM[0]}:{UPSTREAM[1]}; api :{API_PORT}", flush=True)
    async with s1, s2:
        await asyncio.gather(s1.serve_forever(), s2.serve_forever())

if __name__ == "__main__":
    asyncio.run(main())
