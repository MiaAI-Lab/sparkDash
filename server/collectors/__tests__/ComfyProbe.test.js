import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseProgressLine, ComfyProbe } from "../ComfyProbe.js";

// ─── tqdm log parsing ────────────────────────────────────
// ComfyUI sends progress_state only to the submitting client, so the sampler
// step count is scraped out of the server log instead. tqdm rewrites one line
// with \r, so a tail holds many generations of it — the newest must win.

test("parseProgressLine: reads step, steps, elapsed, ETA and s/it", () => {
  const p = parseProgressLine(" 90%|█████████ | 18/20 [11:31<01:18, 39.18s/it]");
  assert.equal(p.step, 18);
  assert.equal(p.steps, 20);
  assert.equal(p.elapsedSeconds, 11 * 60 + 31);
  assert.equal(p.etaSeconds, 78);
  assert.equal(p.secPerStep, 39.18);
});

test("parseProgressLine: takes the LAST match in a tail of rewrites", () => {
  const tail = [
    " 25%|██        | 5/20 [03:12<09:36, 38.40s/it]",
    " 60%|██████    | 12/20 [07:41<05:07, 38.44s/it]",
    " 90%|█████████ | 18/20 [11:31<01:18, 39.18s/it]",
  ].join("\n");
  assert.equal(parseProgressLine(tail).step, 18);
});

test("parseProgressLine: inverts it/s into seconds per step", () => {
  const p = parseProgressLine(" 50%|█████     | 10/20 [00:05<00:05, 2.00it/s]");
  assert.equal(p.secPerStep, 0.5);
});

test("parseProgressLine: hours in the clock", () => {
  const p = parseProgressLine("  5%|▌         | 1/20 [01:50:03<34:50:57, 6603.00s/it]");
  assert.equal(p.elapsedSeconds, 1 * 3600 + 50 * 60 + 3);
  assert.equal(p.etaSeconds, 34 * 3600 + 50 * 60 + 57);
});

test("parseProgressLine: unknown ETA (?) yields null, not NaN", () => {
  const p = parseProgressLine("  0%|          | 0/20 [00:00<?, ?it/s]\n 5%|▌| 1/20 [00:39<12:23, 39.15s/it]");
  assert.equal(p.step, 1);
  assert.equal(p.etaSeconds, 743);
});

test("parseProgressLine: no tqdm output → null", () => {
  assert.equal(parseProgressLine("got prompt\nPrompt executed in 137.12 seconds"), null);
  assert.equal(parseProgressLine(""), null);
  assert.equal(parseProgressLine(null), null);
});

// ─── Probe wiring ────────────────────────────────────────

test("ComfyProbe: local spark probes loopback", () => {
  const probe = new ComfyProbe({ isLocal: true, lanIp: "192.168.178.122" }, 8188);
  assert.equal(probe.baseUrl, "http://127.0.0.1:8188");
});

test("ComfyProbe: remote spark probes lanIp", () => {
  const probe = new ComfyProbe({ isLocal: false, lanIp: "192.168.178.50" }, 8188);
  assert.equal(probe.baseUrl, "http://192.168.178.50:8188");
});

test("ComfyProbe: setPort rejects out-of-range ports but still refreshes host", () => {
  const probe = new ComfyProbe({ isLocal: true }, 8188);
  probe.setPort(70000);
  assert.equal(probe.port, 8188);
  probe.setPort(8189);
  assert.equal(probe.baseUrl, "http://127.0.0.1:8189");
});

test("ComfyProbe: unreachable server reports available:false with an error", async () => {
  // Port 1 is never a ComfyUI; connection is refused immediately.
  const probe = new ComfyProbe({ isLocal: true }, 1);
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.equal(snap.queueRunning, 0);
  assert.equal(snap.job, null);
  assert.match(snap.error, /ComfyUI unreachable/);
});

test("ComfyProbe: _buildJob derives percent from parsed steps", () => {
  const probe = new ComfyProbe({ isLocal: true }, 8188);
  const job = probe._buildJob(
    { id: "abc", execution_start_time: Date.now() - 5000 },
    { step: 5, steps: 20, secPerStep: 39.1, etaSeconds: 586, elapsedSeconds: 196 }
  );
  assert.equal(job.percent, 25);
  assert.equal(job.steps, 20);
  assert.ok(job.elapsedSeconds >= 5 && job.elapsedSeconds < 10);
});

test("ComfyProbe: _buildJob without log progress still reports elapsed", () => {
  const probe = new ComfyProbe({ isLocal: true }, 8188);
  const job = probe._buildJob({ id: "abc", execution_start_time: Date.now() - 1000 }, null);
  assert.equal(job.step, null);
  assert.equal(job.percent, null);
  assert.ok(job.elapsedSeconds >= 1);
});

test("ComfyProbe: no comfyLogPath configured → no step progress, no throw", async () => {
  const probe = new ComfyProbe({ isLocal: true }, 8188);
  assert.equal(await probe._readProgress(), null);
});

test("ComfyProbe: missing log file is not a probe failure", async () => {
  const probe = new ComfyProbe(
    { isLocal: true, comfyLogPath: "/definitely/not/here/comfyui.log" },
    8188
  );
  assert.equal(await probe._readProgress(), null);
});
