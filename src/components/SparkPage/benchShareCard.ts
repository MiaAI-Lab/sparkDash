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
import { decodeBenchTypeLabel } from "../../shared/llmPrompts.js";
import { formatContextSize } from "../../shared/prefillBench.js";
import type { DecodeBenchJob, PrefillBenchJob } from "../../api/types";

/** Fixed width; height grows with the number of result rows. */
export const SHARE_CARD_WIDTH = 1200;
/** A one- or two-row run still exports as a 16:9 card, which crops well on X. */
export const SHARE_CARD_MIN_HEIGHT = 675;
/** Canvas element scale — 2× keeps the PNG crisp when X scales it down. */
export const SHARE_CARD_SCALE = 2;

export type ShareCardTone = "ok" | "warn" | "bad" | "muted";

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

export interface ShareCardModel {
  brand: string;
  /** Unit name, right-aligned on the brand line. Empty when unknown. */
  host: string;
  title: string;
  subtitle: string;
  status: { label: string; tone: ShareCardTone };
  meta: string;
  columns: { load: string; primary: string; secondary: string };
  rows: ShareCardRow[];
  legend: string;
  footer: string;
  /** Epoch ms the card was produced — footer stamp and filename. */
  generatedAt: number;
}

export interface ShareCardSource {
  llmPort: number;
  modelId: string | null;
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
export function shareCardFileName(model: ShareCardModel, kind: "decode" | "prefill"): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
  return `sparkdash-${kind}-${slug(model.host) || "spark"}-${shareCardDate(model.generatedAt)}.png`;
}

export function shareCardStatus(
  status: DecodeBenchJob["status"] | PrefillBenchJob["status"]
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

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s - m * 60).toFixed(0)}s`;
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

/** Colours mirror the app's dark theme so the card matches the dashboard. */
const PALETTE = {
  top: "#0a0a0a",
  bottom: "#181818",
  panel: "#1a1a1a",
  panelBorder: "#353535",
  panelRowBorder: "#2a2a2a",
  badge: "#262626",
  text: "#e4e4e4",
  textStrong: "#ffffff",
  muted: "#8a8a8a",
  accent: "#e8a830",
  success: "#4dbf91",
  danger: "#e5594d",
  warning: "#e0a838",
} as const;

const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const PAD = 56;
const HEADER_BLOCK = 274;
const PANEL_HEADER_HEIGHT = 44;
const PANEL_ROW_HEIGHT = 84;
const LEGEND_BLOCK = 130;

function font(weight: number, size: number): string {
  return `${weight} ${size}px ${FONT_STACK}`;
}

function toneColor(tone: ShareCardTone): string {
  switch (tone) {
    case "ok":
      return PALETTE.success;
    case "warn":
      return PALETTE.warning;
    case "bad":
      return PALETTE.danger;
    default:
      return PALETTE.muted;
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
  const panel = PANEL_HEADER_HEIGHT + Math.max(1, model.rows.length) * PANEL_ROW_HEIGHT;
  return Math.max(SHARE_CARD_MIN_HEIGHT, HEADER_BLOCK + panel + LEGEND_BLOCK);
}

/** Outline the brand mark into a `size`×`size` box whose top-left is (x, y). */
function drawBolt(ctx: ShareCardContext, x: number, y: number, size: number): void {
  ctx.save();
  ctx.beginPath();
  BOLT_POINTS.forEach(([px, py], i) => {
    const cx = x + (px / 24) * size;
    const cy = y + (py / 24) * size;
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  });
  ctx.closePath();
  ctx.strokeStyle = PALETTE.accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawPill(
  ctx: ShareCardContext,
  x: number,
  y: number,
  label: string,
  tone: ShareCardTone
): number {
  ctx.save();
  ctx.font = font(700, 20);
  const width = ctx.measureText(label).width + 40;
  const height = 40;
  ctx.fillStyle = tone === "muted" ? PALETTE.badge : `${toneColor(tone)}29`;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 20);
  ctx.fill();
  ctx.fillStyle = toneColor(tone);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 20, y + height / 2 + 1);
  ctx.restore();
  return width;
}

/** Draw the card. Call with a context scaled to `SHARE_CARD_WIDTH`. */
export function paintShareCard(ctx: ShareCardContext, model: ShareCardModel): void {
  const width = SHARE_CARD_WIDTH;
  const height = shareCardHeight(model);
  const inner = width - PAD * 2;

  const gradient = ctx.createLinearGradient(0, 0, width * 0.4, height);
  gradient.addColorStop(0, PALETTE.top);
  gradient.addColorStop(0.45, "#111111");
  gradient.addColorStop(1, PALETTE.bottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Brand line: mark + wordmark on the left, unit name on the right
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const boltSize = 30;
  drawBolt(ctx, PAD, PAD + 8 - boltSize + 6, boltSize);
  ctx.font = font(700, 22);
  ctx.fillStyle = PALETTE.accent;
  ctx.fillText(model.brand, PAD + boltSize + 12, PAD + 8);
  if (model.host) {
    ctx.textAlign = "right";
    ctx.fillStyle = PALETTE.muted;
    ctx.font = font(600, 22);
    ctx.fillText(fitText(ctx, model.host, inner / 2), width - PAD, PAD + 8);
    ctx.textAlign = "left";
  }

  // Title + subtitle
  ctx.fillStyle = PALETTE.textStrong;
  ctx.font = font(700, 46);
  ctx.fillText(fitText(ctx, model.title, inner), PAD, PAD + 78);
  ctx.fillStyle = PALETTE.muted;
  ctx.font = font(400, 24);
  ctx.fillText(fitText(ctx, model.subtitle, inner), PAD, PAD + 120);

  // Status pill + run meta
  const statusY = PAD + 154;
  const pillWidth = drawPill(ctx, PAD, statusY, model.status.label, model.status.tone);
  ctx.fillStyle = PALETTE.text;
  ctx.font = font(400, 24);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(
    fitText(ctx, model.meta, inner - pillWidth - 20),
    PAD + pillWidth + 20,
    statusY + 21
  );
  ctx.textBaseline = "alphabetic";

  // Results panel
  const panelY = HEADER_BLOCK;
  const panelHeight = PANEL_HEADER_HEIGHT + Math.max(1, model.rows.length) * PANEL_ROW_HEIGHT;
  ctx.fillStyle = PALETTE.panel;
  ctx.beginPath();
  ctx.roundRect(PAD, panelY, inner, panelHeight, 18);
  ctx.fill();
  ctx.strokeStyle = PALETTE.panelBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Column headers
  const colLoad = PAD + 32;
  const colPrimary = PAD + inner - 320;
  const colSecondary = PAD + inner - 32;
  ctx.font = font(600, 18);
  ctx.fillStyle = PALETTE.muted;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(model.columns.load.toUpperCase(), colLoad, panelY + PANEL_HEADER_HEIGHT / 2 + 2);
  ctx.textAlign = "right";
  ctx.fillText(model.columns.primary.toUpperCase(), colPrimary, panelY + PANEL_HEADER_HEIGHT / 2 + 2);
  ctx.fillText(
    model.columns.secondary.toUpperCase(),
    colSecondary,
    panelY + PANEL_HEADER_HEIGHT / 2 + 2
  );

  // Rows
  model.rows.forEach((row, i) => {
    const rowTop = panelY + PANEL_HEADER_HEIGHT + i * PANEL_ROW_HEIGHT;
    const centerY = rowTop + PANEL_ROW_HEIGHT / 2;

    if (i > 0) {
      ctx.save();
      ctx.strokeStyle = PALETTE.panelRowBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(colLoad, rowTop);
      ctx.lineTo(colSecondary, rowTop);
      ctx.stroke();
      ctx.restore();
    }

    // Load badge
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = font(700, 22);
    const badgeWidth = Math.max(56, ctx.measureText(row.load).width + 28);
    ctx.fillStyle = PALETTE.badge;
    ctx.beginPath();
    ctx.roundRect(colLoad, centerY - 22, badgeWidth, 44, 10);
    ctx.fill();
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(
      row.load,
      colLoad + (badgeWidth - ctx.measureText(row.load).width) / 2,
      centerY + 1
    );

    // Row detail
    ctx.font = font(400, 21);
    ctx.fillStyle = PALETTE.muted;
    ctx.fillText(
      fitText(ctx, row.detail, colPrimary - 140 - (colLoad + badgeWidth + 20)),
      colLoad + badgeWidth + 20,
      centerY + 1
    );

    // Primary number, unit right-aligned after it
    ctx.textAlign = "right";
    ctx.font = font(700, 34);
    ctx.fillStyle = row.tone === "bad" ? PALETTE.danger : PALETTE.accent;
    if (row.primaryUnit) {
      ctx.font = font(400, 18);
      const unitWidth = ctx.measureText(row.primaryUnit).width;
      ctx.font = font(700, 34);
      ctx.fillText(row.primary, colPrimary - unitWidth - 10, centerY + 2);
      ctx.font = font(400, 18);
      ctx.fillStyle = PALETTE.muted;
      ctx.fillText(row.primaryUnit, colPrimary, centerY + 6);
    } else {
      ctx.fillText(row.primary, colPrimary, centerY + 2);
    }

    // Secondary number, same treatment
    ctx.font = font(600, 30);
    ctx.fillStyle = row.tone === "bad" ? PALETTE.danger : PALETTE.textStrong;
    if (row.secondaryUnit) {
      ctx.font = font(400, 18);
      const unitWidth = ctx.measureText(row.secondaryUnit).width;
      ctx.font = font(600, 30);
      ctx.fillText(row.secondary, colSecondary - unitWidth - 10, centerY + 2);
      ctx.font = font(400, 18);
      ctx.fillStyle = PALETTE.muted;
      ctx.fillText(row.secondaryUnit, colSecondary, centerY + 6);
    } else {
      ctx.fillText(row.secondary, colSecondary, centerY + 2);
    }
  });

  // Legend
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = font(400, 20);
  ctx.fillStyle = PALETTE.muted;
  ctx.fillText(
    fitText(ctx, model.legend, inner),
    PAD,
    panelY + panelHeight + 42
  );

  // Footer
  ctx.font = font(400, 19);
  ctx.fillText(model.footer, PAD, height - PAD + 6);
  ctx.textAlign = "right";
  ctx.fillText(shareCardDate(model.generatedAt), width - PAD, height - PAD + 6);
}
