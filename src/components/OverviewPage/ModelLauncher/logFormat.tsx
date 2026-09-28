import type { ReactNode } from "react";

/**
 * Lightweight, dependency-free formatter for the model log console.
 *
 * Goal: keep the raw transcript (every line is rendered verbatim — nothing is
 * dropped) but make the lines that actually matter pop. vLLM floods the log
 * with `GET /metrics` / `GET /v1/models` 200 OK access spam, so the two metric
 * lines we care about drown:
 *
 *   - Engine metrics (loggers.py): prompt / generation throughput, queue depth,
 *     KV-cache & prefix/MM cache hit rates.
 *   - SpecDecoding metrics (metrics.py): mean acceptance length, accepted &
 *     drafted throughput, per-position & avg draft acceptance rate.
 *
 * We therefore:
 *   - render each line with a base tone (muted for routine access lines, etc.);
 *   - wrap interesting `Key: value` runs in an emphasis colour — the strongest
 *     accent on the decode-throughput & draft-acceptance numbers, since those
 *     are the ones the operator is watching.
 *
 * Everything is a pure function of a single line: no cross-line state, so it is
 * safe to call per line inside the delta-appended transcript.
 */

// Emphasis rules, each a capture-group-free regex (so indices line up when we
// build one combined matcher). Ordered: the first alternative that matches a
// region wins that region.
type Rule = { re: RegExp; cls: string };

const EMPHASIS: Rule[] = [
  // --- decode throughput & draft acceptance: the headline numbers ---
  { re: /Avg generation throughput: [\d.]+ tokens\/s/, cls: "text-accent font-semibold" },
  { re: /Accepted throughput: [\d.]+ tokens\/s/, cls: "text-accent font-semibold" },
  { re: /Avg Draft acceptance rate: [\d.]+%/, cls: "text-success font-semibold" },
  { re: /Mean acceptance length: [\d.]+/, cls: "text-success font-semibold" },
  // --- supporting throughput ---
  { re: /Avg prompt throughput: [\d.]+ tokens\/s/, cls: "text-text" },
  { re: /Drafted throughput: [\d.]+ tokens\/s/, cls: "text-text" },
  // --- queue depth / memory: amber when it gets interesting ---
  { re: /GPU KV cache usage: \d{2,}(\.\d+)?%/, cls: "text-warning" },
  { re: /Waiting: [1-9]\d* reqs/, cls: "text-warning" },
  { re: /Prefix cache hit rate: [\d.]+%/, cls: "text-success" },
  { re: /MM cache hit rate: [\d.]+%/, cls: "text-success" },
  // --- severity tokens ---
  { re: /\bERROR\b/, cls: "text-danger font-semibold" },
  { re: /\bWARNING\b/, cls: "text-warning font-semibold" },
];

// One combined global matcher; group i corresponds to EMPHASIS[i].
const MASTER = new RegExp(EMPHASIS.map((r) => `(${r.re.source})`).join("|"), "g");

// Routine vLLM HTTP access log — the noise we want to recede into the
// background. Matches e.g. `(APIServer pid=1) INFO:  127.0.0.1:5 - "GET /metrics HTTP/1.1" 200 OK`
const ACCESS = /INFO:\s+\S+\s+-\s+"(GET|POST|HEAD)\s[^"]*"\s+(\d{3})/;
// A non-2xx access status is worth a peek (404/500/etc.).
const ACCESS_BAD = /"(GET|POST|HEAD)\s[^"]*"\s+([45]\d{2})/;

/** Base tone for a whole line, decided before emphasis is layered on. */
function lineClass(line: string): string {
  if (!line) return "text-muted";
  if (line.startsWith("$ ")) return "text-accent"; // command echo (audit trail)
  if (line.startsWith("[cancel]")) return "text-warning"; // our own notices
  if (/\bERROR\b|Traceback|Exception/.test(line)) return "text-danger";
  if (/\bWARNING\b/.test(line)) return "text-warning";
  if (ACCESS.test(line)) return ACCESS_BAD.test(line) ? "text-warning opacity-80" : "text-muted opacity-45";
  if (/SpecDecoding|Avg generation throughput/.test(line)) return "text-muted"; // metric line: let the emphasised runs stand out
  return "";
}

/**
 * Split one raw line into React nodes: plain runs plus emphasis spans. Returns
 * the nodes WITHOUT the trailing newline (the caller adds it) so each line is
 * an inline span with its own base class.
 */
export function formatLogLine(line: string): { base: string; nodes: ReactNode[] } {
  const base = lineClass(line);
  if (!line || !MASTER.test(line)) {
    // Reset the regex's lastIndex (global flag mutates it) and short-circuit.
    MASTER.lastIndex = 0;
    return { base, nodes: [line] };
  }
  MASTER.lastIndex = 0;
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = MASTER.exec(line)) !== null) {
    if (m.index > last) nodes.push(line.slice(last, m.index));
    // Which alternative fired? m[0] is the whole match; find the group index.
    let cls = "";
    for (let i = 1; i <= EMPHASIS.length; i++) {
      if (m[i] !== undefined) {
        cls = EMPHASIS[i - 1].cls;
        break;
      }
    }
    nodes.push(
      <span key={`e${key++}`} className={cls}>
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) MASTER.lastIndex++; // guard against zero-width loops
  }
  if (last < line.length) nodes.push(line.slice(last));
  return { base, nodes };
}
