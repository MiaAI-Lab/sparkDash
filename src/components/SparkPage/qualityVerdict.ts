import type { QualityBenchJob, QualityCategory, QualityFidelityCompare } from "../../api/types";
import { QUALITY_CATEGORY_LABELS, type QualityCompareRow } from "../../shared/qualityBench.js";
import type { DivergenceCompare } from "../../shared/qualityDivergence.js";
import type { QualityNoiseBand } from "./qualityCompare";

/** One area of use, judged in ordinary words. A = this run, B = the compared run. */
export interface AreaVerdict {
  key: "maths" | "knowledge" | "coding" | "prose" | "languages" | "instructions" | "longdocs" | "facts" | "reliability" | "cost";
  area: string;
  tag: "A" | "B" | "same" | "unknown";
  /** The numbers behind the call, in a short clause. */
  evidence: string;
}

export interface PlainVerdict {
  areas: AreaVerdict[];
  /** "B better in 2 areas, A in 0, about the same in 5, not measured in 2" */
  summary: string;
}

const AREA_LABELS: Record<AreaVerdict["key"], string> = {
  maths: "Maths and reasoning",
  knowledge: "Knowledge questions",
  coding: "Coding",
  prose: "Writing and prose",
  languages: "Other languages",
  instructions: "Following instructions and structured output",
  longdocs: "Long documents",
  facts: "Quick facts and arithmetic",
  reliability: "Reliability of the output",
  cost: "Speed and memory",
};

/** A per-token loss difference below this (nats) reads as the same build. */
const NLL_SAME = 0.01;
const signed = (v: number, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;

/** The paired rows of the given categories as plain-words evidence, and who they favour. */
function fromRows(rows: QualityCompareRow[], cats: QualityCategory[], band: QualityNoiseBand | null): { tag: AreaVerdict["tag"]; evidence: string } {
  const picked = rows.filter((r) => cats.includes(r.category) && r.paired > 0);
  if (!picked.length) return { tag: "unknown", evidence: "not in both runs" };
  const parts: string[] = [];
  let aWins = 0;
  let bWins = 0;
  let same = 0;
  for (const r of picked) {
    const name = QUALITY_CATEGORY_LABELS[r.category];
    const delta = r.deltaPts ?? 0;
    const inBand = band?.categories[r.category] != null && Math.abs(delta) <= (band.categories[r.category] as number);
    if (r.verdict === "different" && !inBand) {
      if (delta > 0) aWins += 1;
      else bWins += 1;
      parts.push(`${name} ${signed(delta)} pts`);
    } else {
      same += 1;
      parts.push(`${name} ${signed(delta)} pts (${r.equivalent ? "equivalent" : inBand ? "inside noise" : "no clear difference"})`);
    }
  }
  const tag: AreaVerdict["tag"] = aWins && !bWins ? "A" : bWins && !aWins ? "B" : aWins && bWins ? "same" : "same";
  const mixed = aWins && bWins ? "mixed: " : "";
  return { tag, evidence: `${mixed}${parts.join("; ")}${same === picked.length && picked.length > 1 ? "" : ""}` };
}

/** Fidelity documents of one kind: token-weighted ΔNLL and top-1 agreement. */
function fromFidelity(fidelity: QualityFidelityCompare | null, kindPrefix: string): { tag: AreaVerdict["tag"]; evidence: string } | null {
  const docs = (fidelity?.docs ?? []).filter((d) => d.id.startsWith(`fid-${kindPrefix}`) && d.match && d.dNll != null);
  if (!fidelity?.comparable || !docs.length) return null;
  const tokens = docs.reduce((n, d) => n + d.tokens, 0);
  const dNll = docs.reduce((n, d) => n + (d.dNll ?? 0) * d.tokens, 0) / tokens;
  const agree = docs.filter((d) => d.top1AgreementPct != null);
  const top1 = agree.length ? agree.reduce((n, d) => n + (d.top1AgreementPct ?? 0) * d.tokens, 0) / agree.reduce((n, d) => n + d.tokens, 0) : null;
  const tag: AreaVerdict["tag"] = Math.abs(dNll) < NLL_SAME ? "same" : dNll < 0 ? "A" : "B";
  const who = tag === "same" ? "the same per-token loss" : `${tag === "A" ? "this run" : "the other run"} has the lower per-token loss`;
  return {
    tag,
    evidence: `${who} (${signed(dNll, 3)} nats per token${top1 != null ? `, next-token agreement ${top1.toFixed(1)}%` : ""})`,
  };
}

/** Divergence replies of some kinds: identity and reliability, never a quality call on their own. */
function fromDivergence(div: DivergenceCompare | null, kinds: string[]): string | null {
  if (!div) return null;
  const ks = kinds.filter((k) => div.kinds[k]);
  if (!ks.length) return null;
  const paired = ks.reduce((n, k) => n + div.kinds[k].paired, 0);
  const identical = ks.reduce((n, k) => n + Math.round(((div.kinds[k].identicalPct ?? 0) / 100) * div.kinds[k].paired), 0);
  return `${identical} of ${paired} replies identical`;
}

function merge(primary: { tag: AreaVerdict["tag"]; evidence: string } | null, extras: Array<string | null>): { tag: AreaVerdict["tag"]; evidence: string } {
  const ev = [primary?.evidence, ...extras].filter((s): s is string => Boolean(s));
  return { tag: primary?.tag ?? "unknown", evidence: ev.length ? ev.join("; ") : "not measured in both runs" };
}

/** Combine a pass/fail call with a fidelity call: a clear pass/fail difference wins, else fidelity decides. */
function combine(rowsCall: { tag: AreaVerdict["tag"]; evidence: string }, fidCall: { tag: AreaVerdict["tag"]; evidence: string } | null): { tag: AreaVerdict["tag"]; evidence: string } {
  if (rowsCall.tag === "A" || rowsCall.tag === "B") return merge(rowsCall, [fidCall?.evidence ?? null]);
  if (fidCall && (fidCall.tag === "A" || fidCall.tag === "B")) return merge(fidCall, [rowsCall.tag === "unknown" ? null : rowsCall.evidence]);
  if (rowsCall.tag === "unknown" && !fidCall) return rowsCall;
  return { tag: "same", evidence: [rowsCall.tag === "unknown" ? null : rowsCall.evidence, fidCall?.evidence ?? null].filter(Boolean).join("; ") };
}

/**
 * The comparison in plain words. `fidelity` is the token-by-token comparison when both runs have
 * it (null while it loads), `divergence` the reply-by-reply one, `band` the measured noise floor.
 */
export function plainVerdict({
  job,
  compareJob,
  rows,
  fidelity,
  divergence,
  band,
}: {
  job: QualityBenchJob;
  compareJob: QualityBenchJob;
  rows: QualityCompareRow[];
  fidelity: QualityFidelityCompare | null;
  divergence: DivergenceCompare | null;
  band: QualityNoiseBand | null;
}): PlainVerdict {
  const areas: AreaVerdict[] = [];
  const add = (key: AreaVerdict["key"], call: { tag: AreaVerdict["tag"]; evidence: string }) => areas.push({ key, area: AREA_LABELS[key], ...call });

  add("maths", combine(fromRows(rows, ["arith", "track", "reason", "gsm8k", "math500"], band), fromFidelity(fidelity, "maths")));
  add("knowledge", fromRows(rows, ["mmlupro", "mmlu"], band));
  add("coding", merge(fromFidelity(fidelity, "code"), [fromDivergence(divergence, ["code"])]));
  add("prose", merge(fromFidelity(fidelity, "prose"), [fromDivergence(divergence, ["prose", "long", "turns"])]));
  add("languages", merge(fromFidelity(fidelity, "multi"), [fromDivergence(divergence, ["multi"])]));
  {
    const follow = fromRows(rows, ["follow"], band);
    const structured = (() => {
      if (!divergence) return null;
      const dA = job.results.categories?.divergence?.divergence;
      const dB = compareJob.results.categories?.divergence?.divergence;
      if (!dA || !dB) return null;
      const bits: string[] = [];
      if (dA.jsonSchemaPct != null && dB.jsonSchemaPct != null) bits.push(`JSON schema ${dA.jsonSchemaPct.toFixed(0)}% vs ${dB.jsonSchemaPct.toFixed(0)}%`);
      if (dA.toolOkPct != null && dB.toolOkPct != null) bits.push(`tool calls ${dA.toolOkPct.toFixed(0)}% vs ${dB.toolOkPct.toFixed(0)}%`);
      return bits.length ? bits.join(", ") : null;
    })();
    let call = follow;
    if (follow.tag === "same" || follow.tag === "unknown") {
      const dA = job.results.categories?.divergence?.divergence;
      const dB = compareJob.results.categories?.divergence?.divergence;
      if (dA && dB && dA.jsonSchemaPct != null && dB.jsonSchemaPct != null && dA.toolOkPct != null && dB.toolOkPct != null) {
        const a = dA.jsonSchemaPct + dA.toolOkPct;
        const b = dB.jsonSchemaPct + dB.toolOkPct;
        if (Math.abs(a - b) >= 10) call = { tag: a > b ? "A" : "B", evidence: follow.tag === "unknown" ? "" : follow.evidence };
        else if (follow.tag === "unknown") call = { tag: "same", evidence: "" };
      }
    }
    add("instructions", { tag: call.tag, evidence: [call.evidence, structured].filter(Boolean).join("; ") || "not measured in both runs" });
  }
  add("longdocs", fromRows(rows, ["long"], band));
  add("facts", fromRows(rows, ["qa", "tokenizer"], band));
  {
    if (!divergence) add("reliability", { tag: "unknown", evidence: "needs the Divergence category in both runs" });
    else {
      const loopsDelta = divergence.loopsA - divergence.loopsB;
      const termDelta = divergence.terminatedA - divergence.terminatedB;
      const tag: AreaVerdict["tag"] = loopsDelta < 0 || termDelta > 0 ? (loopsDelta > 0 || termDelta < 0 ? "same" : "A") : loopsDelta > 0 || termDelta < 0 ? "B" : "same";
      add("reliability", {
        tag,
        evidence: `loops ${divergence.loopsA} vs ${divergence.loopsB}, replies that stopped on their own ${divergence.terminatedA} vs ${divergence.terminatedB} of ${divergence.paired}`,
      });
    }
  }
  {
    const ca = job.cost;
    const cb = compareJob.cost;
    const tpsA = ca?.decodeTps1 ?? ca?.perStreamTps ?? null;
    const tpsB = cb?.decodeTps1 ?? cb?.perStreamTps ?? null;
    const memA = ca?.weightsGb ?? ca?.vramUsedGb ?? null;
    const memB = cb?.weightsGb ?? cb?.vramUsedGb ?? null;
    if (tpsA == null && memA == null && tpsB == null && memB == null) add("cost", { tag: "unknown", evidence: "no cost data on these runs" });
    else {
      const bits: string[] = [];
      if (tpsA != null && tpsB != null) bits.push(`${tpsA.toFixed(1)} vs ${tpsB.toFixed(1)} tok/s single stream`);
      if (memA != null && memB != null) bits.push(`${memA.toFixed(1)} vs ${memB.toFixed(1)} GB`);
      const faster = tpsA != null && tpsB != null ? (tpsA > tpsB * 1.1 ? "A" : tpsB > tpsA * 1.1 ? "B" : "same") : null;
      const smaller = memA != null && memB != null ? (memA < memB * 0.9 ? "A" : memB < memA * 0.9 ? "B" : "same") : null;
      const votes = [faster, smaller].filter((v): v is "A" | "B" | "same" => v != null);
      const tag: AreaVerdict["tag"] = !votes.length ? "unknown" : votes.every((v) => v === "A" || v === "same") && votes.includes("A") ? "A" : votes.every((v) => v === "B" || v === "same") && votes.includes("B") ? "B" : votes.includes("A") && votes.includes("B") ? "same" : "same";
      add("cost", { tag, evidence: `${bits.join(", ")}${votes.includes("A") && votes.includes("B") ? " (one is faster, the other smaller)" : ""}` });
    }
  }
  const count = (tag: AreaVerdict["tag"]) => areas.filter((a) => a.tag === tag).length;
  const summary = `A better in ${count("A")}, B better in ${count("B")}, about the same in ${count("same")}, not measured in ${count("unknown")}`;
  return { areas, summary };
}
