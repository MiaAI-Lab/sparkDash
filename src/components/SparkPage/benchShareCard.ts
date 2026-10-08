/**
 * Benchmark share card — the image behind "Copy image".
 *
 * Hand-painted on a canvas instead of screenshotting the DOM: the dashboard
 * ships without UI dependencies, and a card laid out for a timeline (fixed
 * width, one row per level, no modal chrome) reads better than a capture of a
 * scrolling dialog with its Clear/New run/Done buttons. The model is a pure
 * function of the bench job, so every number and label is unit-testable
 * without a real canvas context.
 */
import { formatDuration } from "../../shared/formatDuration";
import { decodeBenchTypeLabel } from "../../shared/llmPrompts.js";
import { backendLabel } from "../../shared/llmBackends.js";
import { formatContextSize } from "../../shared/prefillBench.js";
import { QUALITY_CATEGORIES, QUALITY_CATEGORY_LABELS } from "../../shared/qualityBench.js";
import type { DecodeBenchJob, PrefillBenchJob, QualityBenchJob } from "../../api/types";

/** Fixed width; height grows with the number of result rows. */
export const SHARE_CARD_WIDTH = 1200;
/** A one- or two-row run still exports as a 16:9 card, which crops well on X. */
export const SHARE_CARD_MIN_HEIGHT = 675;
/** Canvas element scale — 2× keeps the PNG crisp when X scales it down. */
export const SHARE_CARD_SCALE = 2;

export type ShareCardTone = "ok" | "warn" | "bad" | "muted" | "accent";

export interface ShareCardRow {
  /** Concurrency (`×1`) or context size (`32k`). */
  load: string;
  /** Facts next to the badge — TTFT, stream count, measured prompt tokens. */
  detail: string;
  /** Headline number: aggregate decode tok/s, or prefill tok/s. */
  primary: string;
  /** Supporting number: per-stream decode tok/s, or TTFT. */
  secondary: string;
  primaryUnit: string;
  secondaryUnit: string;
  tone: ShareCardTone;
}

/** Small pills on the card, mirroring the LLM panel's badges. */
export interface ShareCardChip {
  label: string;
  tone: ShareCardTone;
}

/** One category tile on the Quality card. */
export interface ShareCardTile {
  label: string;
  /** Pass rate 0–100, or null when the category has no score. */
  pct: number | null;
  /** `133/150 items`. */
  detail: string;
  /** Points against the compared run, when there is one. */
  delta: number | null;
}

/** Quality card payload: an overall ring plus a grid of category tiles (replaces the row table). */
export interface ShareCardQuality {
  overall: number | null;
  /** Model under test (large, next to the ring); empty when unknown. */
  modelName: string;
  /** `Port 8888` or the remote host. */
  target: string;
  /** The run's label, e.g. `fp8 KV`; empty when none. */
  runLabel: string;
  /** One-line summary under the model, e.g. `6 categories · 755 items · 41m 54s`. */
  summary: string;
  tiles: ShareCardTile[];
}

export interface ShareCardModel {
  brand: string;
  /** Unit name, right-aligned on the brand line. Empty when unknown. */
  host: string;
  title: string;
  subtitle: string;
  /** Engine + exposure, as the LLM panel shows them. Empty when unknown. */
  chips: ShareCardChip[];
  status: { label: string; tone: ShareCardTone };
  meta: string;
  columns: { load: string; primary: string; secondary: string };
  rows: ShareCardRow[];
  legend: string;
  footer: string;
  /** Epoch ms the card was produced — footer stamp and filename. */
  generatedAt: number;
  /** Set for the Quality card: painted as a ring and tiles instead of the row table. */
  quality?: ShareCardQuality;
}

export interface ShareCardSource {
  llmPort: number;
  modelId: string | null;
  /** Backend id from the probe (`tensorfold`, `sglang`, …). */
  engine?: string | null;
  /** Probe exposure/auth posture, as shown on the LLM panel. */
  posture?: { label: string; level: "ok" | "warn" | "danger" } | null;
  /** Unit display name, when the caller knows it. */
  sparkName?: string | null;
  /** Remote bench host (hostname / URL) instead of this Spark's LAN path. */
  remoteHost?: string | null;
}

/** `2026-09-17` in local time. */
export function shareCardDate(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `sparkdash-decode-spark-38bd-2026-09-17.png` */
export function shareCardFileName(model: ShareCardModel, kind: "decode" | "prefill" | "quality"): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
  return `sparkdash-${kind}-${slug(model.host) || "spark"}-${shareCardDate(model.generatedAt)}.png`;
}

export function shareCardStatus(
  status: DecodeBenchJob["status"] | PrefillBenchJob["status"] | QualityBenchJob["status"]
): { label: string; tone: ShareCardTone } {
  switch (status) {
    case "completed":
      return { label: "COMPLETED", tone: "ok" };
    case "running":
      return { label: "RUNNING", tone: "warn" };
    case "failed":
      return { label: "FAILED", tone: "bad" };
    case "cancelled":
      return { label: "CANCELLED", tone: "muted" };
    default:
      return { label: String(status).toUpperCase(), tone: "muted" };
  }
}

/** Same shapes the dialogs show, so the card reads as the same run. */
function formatTtft(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/**
 * The engine and exposure pills, in the panel's own words and colours: the
 * backend label in the accent tone, the posture in its level's tone.
 */
export function shareCardChips(src: ShareCardSource): ShareCardChip[] {
  const chips: ShareCardChip[] = [];
  const engine = backendLabel(src.engine);
  if (engine) chips.push({ label: engine, tone: "accent" });
  if (src.posture?.label) {
    chips.push({
      label: src.posture.label,
      tone: src.posture.level === "ok" ? "ok" : src.posture.level === "warn" ? "warn" : "bad",
    });
  }
  return chips;
}

/** `Port 8888 · org/model`, or the remote host when the run used one. */
export function shareCardSubtitle(src: ShareCardSource): string {
  const target = src.remoteHost ? src.remoteHost : `Port ${src.llmPort}`;
  return src.modelId ? `${target} · ${src.modelId}` : target;
}

/**
 * Decode card — mirrors the dialog table: LOAD · AGGREGATE · STREAM, with TTFT
 * and the ok/total stream count as the row detail.
 */
export function buildDecodeShareCard(
  job: DecodeBenchJob,
  src: ShareCardSource,
  now: number = Date.now()
): ShareCardModel {
  const rows = job.results
    .slice()
    .sort((a, b) => a.concurrency - b.concurrency)
    .map<ShareCardRow>((r) => {
      const failed = r.totalDecodeTokens <= 0 && r.totalCompletionTokens <= 0;
      const streams = r.streamsOk + r.streamsFailed;
      const agg = r.aggregateDecodeTps > 0 ? r.aggregateDecodeTps : r.meanDecodeTps;
      return {
        load: `×${r.concurrency}`,
        detail: failed
          ? r.error || "failed"
          : `TTFT ${formatTtft(r.meanTtftMs)} · ${r.streamsOk}/${streams} streams`,
        primary: failed ? "—" : agg.toFixed(1),
        secondary: failed ? "—" : r.meanDecodeTps.toFixed(1),
        primaryUnit: "tok/s",
        secondaryUnit: "tok/s",
        tone: failed ? "bad" : "ok",
      };
    });

  const concurrencies = job.config?.concurrencies ?? [];
  return {
    brand: "sparkDash",
    host: src.sparkName || "",
    title: "Decode benchmark",
    subtitle: shareCardSubtitle(src),
    chips: shareCardChips(src),
    status: shareCardStatus(job.status),
    meta: `${decodeBenchTypeLabel(job.config?.promptType)} · ${job.config?.maxTokens ?? "?"} tok · ${
      concurrencies.length ? `${concurrencies.join(", ")} conc` : "—"
    }${job.durationMs != null ? ` · ${formatDuration(job.durationMs)}` : ""}`,
    columns: { load: "Load", primary: "Aggregate", secondary: "Stream" },
    rows,
    legend:
      "Aggregate — total decode tok/s across all concurrent streams. Stream — per-stream average decode.",
    footer: "github.com/MiaAI-Lab/sparkDash",
    generatedAt: now,
  };
}

/**
 * Prefill card — LOAD · PREFILL · TTFT, with the measured prompt size as the
 * row detail, exactly like the prefill dialog.
 */
export function buildPrefillShareCard(
  job: PrefillBenchJob,
  src: ShareCardSource,
  now: number = Date.now()
): ShareCardModel {
  const rows = job.results
    .slice()
    .sort((a, b) => a.targetTokens - b.targetTokens)
    .map<ShareCardRow>((r) => {
      const failed = r.prefillTps <= 0;
      return {
        load: formatContextSize(r.targetTokens),
        detail: failed
          ? r.error || "failed"
          : `TTFT ${formatTtft(r.ttftMs)} · ${
              r.promptTokens > 0 ? `${r.promptTokens.toLocaleString("en-US")} tokens` : "—"
            }`,
        primary: failed ? "—" : r.prefillTps.toFixed(1),
        secondary: failed ? "—" : formatTtft(r.ttftMs),
        primaryUnit: "tok/s",
        secondaryUnit: "",
        tone: failed ? "bad" : "ok",
      };
    });

  const sizes = job.config?.contextSizes ?? [];
  return {
    brand: "sparkDash",
    host: src.sparkName || "",
    title: "Prefill benchmark",
    subtitle: shareCardSubtitle(src),
    chips: shareCardChips(src),
    status: shareCardStatus(job.status),
    meta: `${sizes.length ? `${sizes.map(formatContextSize).join(", ")} ctx` : "—"}${
      job.durationMs != null ? ` · ${formatDuration(job.durationMs)}` : ""
    }`,
    columns: { load: "Context", primary: "Prefill", secondary: "TTFT" },
    rows,
    legend: "Prefill — prompt tokens ÷ time to first token. TTFT — time to first token.",
    footer: "github.com/MiaAI-Lab/sparkDash",
    generatedAt: now,
  };
}

/**
 * Quality card — one row per category: SCORE (pass %) and, when a previous run
 * is compared, the points delta against it. Reuses the generic row layout.
 */
export function buildQualityShareCard(
  job: QualityBenchJob,
  compare: QualityBenchJob | null,
  src: ShareCardSource,
  now: number = Date.now()
): ShareCardModel {
  const rows: ShareCardRow[] = [];
  for (const cat of QUALITY_CATEGORIES) {
    const s = job.results?.categories?.[cat];
    if (!s) continue;
    const other = compare?.results?.categories?.[cat];
    const delta = s.pct != null && other?.pct != null ? Math.round((s.pct - other.pct) * 10) / 10 : null;
    rows.push({
      load: QUALITY_CATEGORY_LABELS[cat],
      detail: `${s.passed}/${s.total} items`,
      primary: s.pct == null ? "—" : s.pct.toFixed(1),
      secondary: delta == null ? "" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`,
      primaryUnit: "%",
      secondaryUnit: delta == null ? "" : "pts",
      tone: s.pct == null ? "bad" : delta != null && delta < 0 ? "warn" : "ok",
    });
  }
  const overall = job.results?.overallPct;
  const tiles: ShareCardTile[] = rows.map((r, i) => {
    const cat = QUALITY_CATEGORIES.filter((c) => job.results?.categories?.[c])[i];
    const s = job.results?.categories?.[cat];
    const other = compare?.results?.categories?.[cat];
    return {
      label: r.load,
      pct: s?.pct ?? null,
      detail: r.detail,
      delta: s?.pct != null && other?.pct != null ? Math.round((s.pct - other.pct) * 10) / 10 : null,
    };
  });
  const catKeys = QUALITY_CATEGORIES.filter((c) => job.results?.categories?.[c]);
  const itemTotal = catKeys.reduce((n, c) => n + (job.results?.categories?.[c]?.total ?? 0), 0);
  const summary = [
    `${tiles.length} ${tiles.length === 1 ? "category" : "categories"}`,
    `${itemTotal.toLocaleString("en-US")} items`,
    ...(job.durationMs != null ? [formatDuration(job.durationMs)] : []),
  ].join(" · ");
  return {
    quality: {
      overall: overall ?? null,
      modelName: src.modelId || "",
      target: src.remoteHost ? src.remoteHost : `Port ${src.llmPort}`,
      runLabel: job.config?.label || "",
      summary,
      tiles,
    },
    brand: "sparkDash",
    host: src.sparkName || "",
    title: "Quality benchmark",
    subtitle: shareCardSubtitle(src),
    chips: shareCardChips(src),
    status: shareCardStatus(job.status),
    meta: `Overall ${overall == null ? "—" : `${overall.toFixed(1)}%`}${job.config?.label ? ` · ${job.config.label}` : ""}${
      job.durationMs != null ? ` · ${formatDuration(job.durationMs)}` : ""
    }`,
    columns: { load: "Category", primary: "Score", secondary: compare ? "vs other" : "" },
    rows,
    legend: "Score — share of items passed. Temperature 0, fixed seed.",
    footer: "github.com/MiaAI-Lab/sparkDash",
    generatedAt: now,
  };
}

// ─── Painting ────────────────────────────────────────────────
// The painter touches a narrow slice of the 2D context, which keeps it testable
// with a recording fake — no canvas backend needed in the test environment.

export type ShareCardContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "arc"
  | "fill"
  | "stroke"
  | "fillRect"
  | "fillText"
  | "measureText"
  | "roundRect"
  | "createLinearGradient"
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "lineCap"
  | "font"
  | "textAlign"
  | "textBaseline"
>;

/**
 * Brand mark, as the vertices of `assets/bolt.svg` (that file is the source of
 * truth; the unit test fails if its path stops matching these points). The card
 * draws the polygon rather than loading the SVG, so the paint stays synchronous
 * and cannot fail on a fetch.
 */
export const BOLT_POINTS: ReadonlyArray<readonly [number, number]> = [
  [13, 2],
  [3, 14],
  [12, 14],
  [11, 22],
  [21, 10],
  [12, 10],
];

export type ShareCardTheme = "dark" | "light" | "white";

interface Palette {
  /** Card background. */
  bg: string;
  panel: string;
  panelBorder: string;
  rowBorder: string;
  /** Row badge and bar-track fill. */
  badge: string;
  text: string;
  textStrong: string;
  muted: string;
  /** Brand colour for fills (logo, bars). */
  accent: string;
  /** Brand colour for text; darker on the light card so it stays readable. */
  accentText: string;
  /** Text / icon colour on an accent fill. */
  onAccent: string;
  success: string;
  warning: string;
  danger: string;
}

/**
 * The app's own theme tokens (src/index.css), so the card looks like the dashboard
 * it came from: Dark/OLED produce the dark card, White/Light the light one.
 */
const PALETTES: Record<ShareCardTheme, Palette> = {
  dark: {
    bg: "#0a0c0f",
    panel: "#12151a",
    panelBorder: "#232830",
    rowBorder: "#232830",
    badge: "#1f242b",
    text: "#e9ecf0",
    textStrong: "#ffffff",
    muted: "#8a919c",
    accent: "#f0b03a",
    accentText: "#f4b942",
    onAccent: "#1c1404",
    success: "#3fd08f",
    warning: "#ff914d",
    danger: "#ff5d62",
  },
  light: {
    bg: "#dce0e7",
    panel: "#ffffff",
    panelBorder: "#cfd5de",
    rowBorder: "#e3e7ed",
    badge: "#eceff4",
    text: "#12161c",
    textStrong: "#000000",
    muted: "#5a6370",
    accent: "#e8a21c",
    accentText: "#8c5a00",
    onAccent: "#1c1404",
    success: "#12915f",
    warning: "#c85a10",
    danger: "#cf3038",
  },
  // The app's first light theme ("White"): near-white page, white panels.
  white: {
    bg: "#f3f4f6",
    panel: "#ffffff",
    panelBorder: "#e1e4e9",
    rowBorder: "#eceef2",
    badge: "#eceef2",
    text: "#14181e",
    textStrong: "#000000",
    muted: "#5c6470",
    accent: "#e8a21c",
    accentText: "#8c5a00",
    onAccent: "#1c1404",
    success: "#12915f",
    warning: "#c85a10",
    danger: "#cf3038",
  },
};

/**
 * Card theme for the page as it is right now. The active app theme decides:
 * "dark" and "oled" give the dark card, "light" the light card, "white" the near-white
 * card (matching that theme's lighter page), and anything unknown falls back to dark.
 */
export function detectShareCardTheme(): ShareCardTheme {
  if (typeof document === "undefined") return "dark";
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" || t === "white" ? t : "dark";
}

/** Geist is bundled with the app; the rest is a safe fallback for odd environments. */
const FONT_STACK =
  '"Geist Variable", "Geist", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const PAD = 56;
const HEADER_BLOCK = 318;
const CHIP_HEIGHT = 30;
const PANEL_HEADER_HEIGHT = 44;
const PANEL_ROW_HEIGHT = 92;
const LEGEND_BLOCK = 130;
/** Where the Quality card's hero panel starts (below the brand line and the title row). */
const QUALITY_TOP = 156;
const QUALITY_HERO_HEIGHT = 224;
const QUALITY_TILE_HEIGHT = 108;
const QUALITY_TILE_GAP = 16;

function font(weight: number, size: number): string {
  return `${weight} ${size}px ${FONT_STACK}`;
}

function toneColor(P: Palette, tone: ShareCardTone): string {
  switch (tone) {
    case "ok":
      return P.success;
    case "warn":
      return P.warning;
    case "bad":
      return P.danger;
    case "accent":
      return P.accentText;
    default:
      return P.muted;
  }
}

/** Trim to `maxWidth` with an ellipsis — the card has a fixed width. */
function fitText(ctx: ShareCardContext, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** Panel height is one row per level, so a 12-level sweep grows, not clips. */
export function shareCardHeight(model: ShareCardModel): number {
  if (model.quality) {
    const rows = Math.max(1, Math.ceil(model.quality.tiles.length / 2));
    const tilesBottom = QUALITY_TOP + QUALITY_HERO_HEIGHT + 22 + rows * (QUALITY_TILE_HEIGHT + QUALITY_TILE_GAP) - QUALITY_TILE_GAP;
    return Math.max(SHARE_CARD_MIN_HEIGHT, tilesBottom + 120);
  }
  const panel = PANEL_HEADER_HEIGHT + Math.max(1, model.rows.length) * PANEL_ROW_HEIGHT;
  return Math.max(SHARE_CARD_MIN_HEIGHT, HEADER_BLOCK + panel + LEGEND_BLOCK);
}

/**
 * Per-row bar lengths (0–1) relative to the largest headline number, like the bars
 * under each row in the app. Null when any row has no plain number (e.g. a failed level).
 */
export function shareCardBarFractions(rows: readonly ShareCardRow[]): number[] | null {
  if (!rows.length) return null;
  const values = rows.map((r) => {
    const digits = String(r.primary).replace(/[^0-9.]/g, "");
    return /\d/.test(digits) ? Number(digits) : Number.NaN; // "—" is "no number", not 0
  });
  if (values.some((v) => !Number.isFinite(v))) return null;
  const max = Math.max(...values);
  if (!(max > 0)) return null;
  return values.map((v) => v / max);
}

/** The brand tile: accent rounded square with the bolt outlined inside, like the sidebar logo. */
function drawLogo(ctx: ShareCardContext, P: Palette, x: number, y: number, size: number): void {
  ctx.save();
  ctx.fillStyle = P.accent;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, size * 0.3);
  ctx.fill();
  const inner = size * 0.6;
  const ox = x + (size - inner) / 2;
  const oy = y + (size - inner) / 2;
  ctx.beginPath();
  BOLT_POINTS.forEach(([px, py], i) => {
    const cx = ox + (px / 24) * inner;
    const cy = oy + (py / 24) * inner;
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  });
  ctx.closePath();
  ctx.strokeStyle = P.onAccent;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.restore();
}

/** One tag-style pill: tone at ~14% behind, tone for the dot and text (same recipe as the app's `.tag--*`). */
function drawChip(ctx: ShareCardContext, P: Palette, x: number, y: number, chip: ShareCardChip): number {
  ctx.save();
  ctx.font = font(600, 19);
  const textWidth = ctx.measureText(chip.label).width;
  const width = textWidth + 46;
  const tone = toneColor(P, chip.tone);
  ctx.fillStyle = `${tone}24`;
  ctx.beginPath();
  ctx.roundRect(x, y, width, CHIP_HEIGHT, CHIP_HEIGHT / 2);
  ctx.fill();
  ctx.fillStyle = tone;
  ctx.beginPath();
  ctx.arc(x + 18, y + CHIP_HEIGHT / 2, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(chip.label, x + 28, y + CHIP_HEIGHT / 2 + 1);
  ctx.restore();
  return width;
}

function drawPill(ctx: ShareCardContext, P: Palette, x: number, y: number, label: string, tone: ShareCardTone): number {
  ctx.save();
  ctx.font = font(700, 20);
  const width = ctx.measureText(label).width + 40;
  const height = 40;
  ctx.fillStyle = tone === "muted" ? P.badge : `${toneColor(P, tone)}24`;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 20);
  ctx.fill();
  ctx.fillStyle = toneColor(P, tone);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 20, y + height / 2 + 1);
  ctx.restore();
  return width;
}

/** Draw the card. Call with a context scaled to `SHARE_CARD_WIDTH`. */
export function paintShareCard(
  ctx: ShareCardContext,
  model: ShareCardModel,
  theme: ShareCardTheme = "dark"
): void {
  const P = PALETTES[theme] ?? PALETTES.dark;
  const width = SHARE_CARD_WIDTH;
  const height = shareCardHeight(model);
  const inner = width - PAD * 2;

  // Flat page colour, like the app's body.
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, width, height);

  // Brand line: logo tile + two-tone wordmark on the left, unit name on the right
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const logo = 40;
  drawLogo(ctx, P, PAD, PAD - 24, logo);
  ctx.font = font(700, 26);
  ctx.fillStyle = P.textStrong;
  const wordX = PAD + logo + 14;
  ctx.fillText("spark", wordX, PAD + 6);
  const sparkWidth = ctx.measureText("spark").width;
  ctx.font = font(400, 26);
  ctx.fillStyle = P.muted;
  ctx.fillText("Dash", wordX + sparkWidth, PAD + 6);
  if (model.host) {
    ctx.textAlign = "right";
    ctx.fillStyle = P.muted;
    ctx.font = font(500, 22);
    ctx.fillText(fitText(ctx, model.host, inner / 2), width - PAD, PAD + 6);
    ctx.textAlign = "left";
  }

  if (model.quality) {
    const bottom = paintQualityCard(ctx, P, model);
    paintFooter(ctx, P, model, bottom + 42, height);
    return;
  }

  // Title + subtitle
  ctx.fillStyle = P.textStrong;
  ctx.font = font(700, 46);
  ctx.fillText(fitText(ctx, model.title, inner), PAD, PAD + 78);
  ctx.fillStyle = P.muted;
  ctx.font = font(400, 24);
  ctx.fillText(fitText(ctx, model.subtitle, inner), PAD, PAD + 120);

  // Engine + exposure pills, on their own row like the panel's badge row
  let chipX = PAD;
  const chipY = PAD + 140;
  model.chips.forEach((chip) => {
    const w = drawChip(ctx, P, chipX, chipY, chip);
    chipX += w + 10;
  });

  // Status pill + run meta
  const statusY = PAD + 198;
  const pillWidth = drawPill(ctx, P, PAD, statusY, model.status.label, model.status.tone);
  ctx.fillStyle = P.text;
  ctx.font = font(400, 24);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(fitText(ctx, model.meta, inner - pillWidth - 20), PAD + pillWidth + 20, statusY + 21);
  ctx.textBaseline = "alphabetic";

  // Results panel
  const panelY = HEADER_BLOCK;
  const panelHeight = PANEL_HEADER_HEIGHT + Math.max(1, model.rows.length) * PANEL_ROW_HEIGHT;
  ctx.fillStyle = P.panel;
  ctx.beginPath();
  ctx.roundRect(PAD, panelY, inner, panelHeight, 18);
  ctx.fill();
  ctx.strokeStyle = P.panelBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Column headers
  const colLoad = PAD + 32;
  const colPrimary = PAD + inner - 320;
  const colSecondary = PAD + inner - 32;
  ctx.font = font(600, 18);
  ctx.fillStyle = P.muted;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(model.columns.load.toUpperCase(), colLoad, panelY + PANEL_HEADER_HEIGHT / 2 + 2);
  ctx.textAlign = "right";
  ctx.fillText(model.columns.primary.toUpperCase(), colPrimary, panelY + PANEL_HEADER_HEIGHT / 2 + 2);
  ctx.fillText(model.columns.secondary.toUpperCase(), colSecondary, panelY + PANEL_HEADER_HEIGHT / 2 + 2);

  const bars = shareCardBarFractions(model.rows);

  // Rows
  model.rows.forEach((row, i) => {
    const rowTop = panelY + PANEL_HEADER_HEIGHT + i * PANEL_ROW_HEIGHT;
    const centerY = rowTop + 38;

    ctx.save();
    ctx.strokeStyle = P.rowBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD + 1, rowTop);
    ctx.lineTo(PAD + inner - 1, rowTop);
    ctx.stroke();
    ctx.restore();

    // Load badge
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = font(700, 22);
    const badgeWidth = Math.max(56, ctx.measureText(row.load).width + 28);
    ctx.fillStyle = P.badge;
    ctx.beginPath();
    ctx.roundRect(colLoad, centerY - 22, badgeWidth, 44, 10);
    ctx.fill();
    ctx.fillStyle = P.text;
    ctx.fillText(row.load, colLoad + (badgeWidth - ctx.measureText(row.load).width) / 2, centerY + 1);

    // Row detail
    ctx.font = font(400, 21);
    ctx.fillStyle = P.muted;
    ctx.fillText(
      fitText(ctx, row.detail, colPrimary - 140 - (colLoad + badgeWidth + 20)),
      colLoad + badgeWidth + 20,
      centerY + 1
    );

    // Primary number, unit right-aligned after it
    ctx.textAlign = "right";
    ctx.fillStyle = row.tone === "bad" ? P.danger : P.accentText;
    if (row.primaryUnit) {
      ctx.font = font(400, 18);
      const unitWidth = ctx.measureText(row.primaryUnit).width;
      ctx.font = font(700, 34);
      ctx.fillText(row.primary, colPrimary - unitWidth - 10, centerY + 2);
      ctx.font = font(400, 18);
      ctx.fillStyle = P.muted;
      ctx.fillText(row.primaryUnit, colPrimary, centerY + 6);
    } else {
      ctx.font = font(700, 34);
      ctx.fillText(row.primary, colPrimary, centerY + 2);
    }

    // Secondary number, same treatment
    ctx.fillStyle = row.tone === "bad" ? P.danger : P.textStrong;
    if (row.secondaryUnit) {
      ctx.font = font(400, 18);
      const unitWidth = ctx.measureText(row.secondaryUnit).width;
      ctx.font = font(600, 30);
      ctx.fillText(row.secondary, colSecondary - unitWidth - 10, centerY + 2);
      ctx.font = font(400, 18);
      ctx.fillStyle = P.muted;
      ctx.fillText(row.secondaryUnit, colSecondary, centerY + 6);
    } else {
      ctx.font = font(600, 30);
      ctx.fillText(row.secondary, colSecondary, centerY + 2);
    }

    // Bar under the row, as in the app's results list
    if (bars) {
      const barY = rowTop + 70;
      const barW = colSecondary - colLoad;
      ctx.fillStyle = P.badge;
      ctx.beginPath();
      ctx.roundRect(colLoad, barY, barW, 6, 3);
      ctx.fill();
      ctx.fillStyle = row.tone === "bad" ? P.danger : P.accent;
      ctx.beginPath();
      ctx.roundRect(colLoad, barY, Math.max(6, barW * bars[i]), 6, 3);
      ctx.fill();
    }
  });

  paintFooter(ctx, P, model, panelY + panelHeight + 42, height);
}

/** Legend line under the body, then the repo link and date at the bottom. */
function paintFooter(ctx: ShareCardContext, P: Palette, model: ShareCardModel, legendY: number, height: number): void {
  const width = SHARE_CARD_WIDTH;
  const inner = width - PAD * 2;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = font(400, 20);
  ctx.fillStyle = P.muted;
  ctx.fillText(fitText(ctx, model.legend, inner), PAD, legendY);
  ctx.font = font(400, 19);
  ctx.fillText(model.footer, PAD, height - PAD + 6);
  ctx.textAlign = "right";
  ctx.fillText(shareCardDate(model.generatedAt), width - PAD, height - PAD + 6);
}

/** Score band colours, like the app's results page: green from 90, amber from 70, red below. */
export function qualityTierColor(P: { success: string; accent: string; danger: string; muted: string }, pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return P.muted;
  return pct >= 90 ? P.success : pct >= 70 ? P.accent : P.danger;
}

/** Text colour for a score: the band's colour, using the darker amber so it reads on light cards. */
function qualityTextColor(P: Palette, pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return P.muted;
  return pct >= 90 ? P.success : pct >= 70 ? P.accentText : P.danger;
}

/**
 * The Quality card from the title down: title + status, a hero with the overall ring and the
 * model under test, then a two-column grid of category tiles. Returns the bottom edge's y.
 */
function paintQualityCard(ctx: ShareCardContext, P: Palette, model: ShareCardModel): number {
  const q = model.quality as ShareCardQuality;
  const inner = SHARE_CARD_WIDTH - PAD * 2;

  // Title, with the run status at the right on the same line
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.textStrong;
  ctx.font = font(700, 44);
  ctx.fillText("Quality benchmark", PAD, PAD + 78);
  ctx.font = font(700, 20);
  const pillW = ctx.measureText(model.status.label).width + 40;
  drawPill(ctx, P, PAD + inner - pillW, PAD + 46, model.status.label, model.status.tone);

  // Hero panel
  const top = QUALITY_TOP;
  ctx.fillStyle = P.panel;
  ctx.beginPath();
  ctx.roundRect(PAD, top, inner, QUALITY_HERO_HEIGHT, 20);
  ctx.fill();
  ctx.strokeStyle = P.panelBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Overall ring
  const radius = 76;
  const cx = PAD + 48 + radius + 8;
  const cy = top + QUALITY_HERO_HEIGHT / 2;
  const tier = qualityTierColor(P, q.overall);
  ctx.lineWidth = 16;
  ctx.lineCap = "butt";
  ctx.strokeStyle = P.badge;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  if (q.overall != null && q.overall > 0) {
    ctx.strokeStyle = tier;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (Math.min(100, q.overall) / 100) * Math.PI * 2);
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.muted;
  ctx.font = font(600, 15);
  ctx.fillText("OVERALL", cx, cy - 30);
  ctx.fillStyle = P.textStrong;
  ctx.font = font(700, 48);
  const score = q.overall == null ? "—" : q.overall.toFixed(1);
  ctx.fillText(score, cx - (q.overall == null ? 0 : 8), cy + 18);
  if (q.overall != null) {
    ctx.font = font(500, 22);
    ctx.fillStyle = P.muted;
    ctx.textAlign = "left";
    ctx.font = font(700, 48);
    const w = ctx.measureText(score).width;
    ctx.font = font(500, 22);
    ctx.fillText("%", cx - 8 + w / 2 + 3, cy + 18);
  }

  // The model under test, big, with where it ran and what it is
  const textX = cx + radius + 64;
  const textW = PAD + inner - 40 - textX;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = P.textStrong;
  ctx.font = font(700, 36);
  ctx.fillText(fitText(ctx, q.modelName || "Unknown model", textW), textX, cy - 40);
  ctx.fillStyle = P.muted;
  ctx.font = font(500, 22);
  const where = [q.target, q.runLabel].filter(Boolean).join(" · ");
  ctx.fillText(fitText(ctx, where, textW), textX, cy - 8);

  // Engine and exposure pills
  let chipX = textX;
  const chipY = cy + 8;
  for (const chip of model.chips) {
    const w = drawChip(ctx, P, chipX, chipY, chip);
    chipX += w + 10;
  }
  ctx.fillStyle = P.text;
  ctx.font = font(400, 22);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(fitText(ctx, q.summary, textW), textX, cy + 78);

  // Tiles
  const gap = 20;
  const tileW = (inner - gap) / 2;
  const gridTop = top + QUALITY_HERO_HEIGHT + 22;
  q.tiles.forEach((tile, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = PAD + col * (tileW + gap);
    const y = gridTop + row * (QUALITY_TILE_HEIGHT + QUALITY_TILE_GAP);
    ctx.fillStyle = P.panel;
    ctx.beginPath();
    ctx.roundRect(x, y, tileW, QUALITY_TILE_HEIGHT, 16);
    ctx.fill();
    ctx.strokeStyle = P.panelBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    const bar = qualityTierColor(P, tile.pct);
    const text = qualityTextColor(P, tile.pct);
    const left = x + 26;
    const right = x + tileW - 26;

    // Name + items on the left, score on the right, sharing one baseline row
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = P.textStrong;
    ctx.font = font(700, 26);
    ctx.fillText(fitText(ctx, tile.label, tileW - 230), left, y + 42);
    ctx.fillStyle = P.muted;
    ctx.font = font(400, 20);
    ctx.fillText(fitText(ctx, tile.detail, tileW - 230), left, y + 70);

    ctx.textAlign = "right";
    ctx.font = font(500, 20);
    const unitW = tile.pct == null ? 0 : ctx.measureText("%").width + 4;
    ctx.fillStyle = text;
    ctx.font = font(700, 44);
    ctx.fillText(tile.pct == null ? "—" : tile.pct.toFixed(1), right - unitW, y + 50);
    if (tile.pct != null) {
      ctx.font = font(500, 20);
      ctx.fillStyle = P.muted;
      ctx.fillText("%", right, y + 50);
    }
    if (tile.delta != null) {
      ctx.font = font(600, 19);
      ctx.fillStyle = tile.delta > 0 ? P.success : tile.delta < 0 ? P.danger : P.muted;
      ctx.fillText(tile.delta === 0 ? "same" : `${tile.delta > 0 ? "+" : ""}${tile.delta.toFixed(1)} pts`, right, y + 76);
    }

    // Bar
    const barW = right - left;
    const barY = y + QUALITY_TILE_HEIGHT - 22;
    ctx.fillStyle = P.badge;
    ctx.beginPath();
    ctx.roundRect(left, barY, barW, 8, 4);
    ctx.fill();
    if (tile.pct != null && tile.pct > 0) {
      ctx.fillStyle = bar;
      ctx.beginPath();
      ctx.roundRect(left, barY, Math.max(8, (barW * Math.min(100, tile.pct)) / 100), 8, 4);
      ctx.fill();
    }
  });
  const rows = Math.max(1, Math.ceil(q.tiles.length / 2));
  return gridTop + rows * (QUALITY_TILE_HEIGHT + QUALITY_TILE_GAP) - QUALITY_TILE_GAP;
}
