import { useTranslation } from "react-i18next";
import type { LlmCluster, LlmClusterPart, LlmClusterRank } from "../../api/types";
import { Tag } from "../ui/Tag";
import { fmtNum, fmtPct } from "./LlmServerCharts";

const gib = (bytes: number | null | undefined): string =>
  bytes == null || !Number.isFinite(bytes) ? "—" : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

const count = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString();

const sum = (...values: Array<number | null>): number | null => {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
};

function ClusterNode({
  id,
  part,
  rank,
  partRows,
}: {
  id: string;
  part: LlmClusterPart | null;
  rank: LlmClusterRank | null;
  partRows: number | null;
}) {
  const { t } = useTranslation("spark");
  const totalRows =
    partRows ??
    (part
      ? sum(part.freeRows, part.liveRows, part.keptRows, part.twinRows, part.holdRows)
      : null);
  const occupied =
    totalRows != null && totalRows > 0 && part?.freeRows != null
      ? (totalRows - part.freeRows) / totalRows
      : null;
  const storedShare =
    rank?.storedBytes != null && rank.capacityBytes != null && rank.capacityBytes > 0
      ? rank.storedBytes / rank.capacityBytes
      : null;
  const errors = sum(rank?.writesFailed ?? null, rank?.readFailed ?? null, rank?.crcErrors ?? null, rank?.sizeErrors ?? null);
  const segments = part
    ? [
        { key: "live", value: part.liveRows, cls: "is-live" },
        { key: "kept", value: part.keptRows, cls: "is-kept" },
        { key: "twin", value: part.twinRows, cls: "is-twin" },
        { key: "hold", value: part.holdRows, cls: "is-hold" },
        { key: "free", value: part.freeRows, cls: "is-free" },
      ]
    : [];
  const segmentTotal = sum(...segments.map((s) => s.value));

  return (
    <div className="ls-cluster-card">
      <div className="ls-cluster-card__head">
        <span className="ls-cluster-card__title">{t("llmServer.nodeTitle", { id })}</span>
        {occupied != null ? (
          <Tag tone={occupied >= 0.9 ? "warn" : "info"}>{t("llmServer.kvOccupied", { pct: fmtPct(occupied) })}</Tag>
        ) : null}
      </div>

      {part ? (
        <>
          <div
            className="ls-cluster-bar"
            role="img"
            aria-label={t("llmServer.kvRowsAria", {
              free: count(part.freeRows),
              live: count(part.liveRows),
              kept: count(part.keptRows),
              twin: count(part.twinRows),
              hold: count(part.holdRows),
            })}
          >
            {segments.map((segment) => (
              <i
                key={segment.key}
                className={segment.cls}
                style={{
                  width:
                    segmentTotal != null && segmentTotal > 0 && segment.value != null
                      ? `${Math.min(100, (segment.value / segmentTotal) * 100)}%`
                      : 0,
                }}
              />
            ))}
          </div>
          <ul className="ls-cluster-legend">
            <li>
              <span aria-hidden className="ls-cluster-legend__dot is-live" />
              <span>{t("llmServer.rowsLive")}</span>
              <b>{count(part.liveRows)}</b>
            </li>
            <li>
              <span aria-hidden className="ls-cluster-legend__dot is-kept" />
              <span>{t("llmServer.rowsKept")}</span>
              <b>{count(part.keptRows)}</b>
            </li>
            <li>
              <span aria-hidden className="ls-cluster-legend__dot is-twin" />
              <span>{t("llmServer.rowsTwin")}</span>
              <b>{count(part.twinRows)}</b>
            </li>
            <li>
              <span aria-hidden className="ls-cluster-legend__dot is-hold" />
              <span>{t("llmServer.rowsHold")}</span>
              <b>{count(part.holdRows)}</b>
            </li>
            <li>
              <span aria-hidden className="ls-cluster-legend__dot is-free" />
              <span>{t("llmServer.rowsFree")}</span>
              <b>{count(part.freeRows)}</b>
            </li>
          </ul>
          <div className="ls-cluster-metrics">
            <div className="ls-cluster-metric">
              <span>{t("llmServer.partRows")}</span>
              <b>{count(totalRows)}</b>
            </div>
            <div className="ls-cluster-metric">
              <span>{t("llmServer.liveStreams")}</span>
              <b>{count(part.liveStreams)}</b>
            </div>
          </div>
        </>
      ) : null}

      {rank ? (
        <>
          <div className="ls-cluster-subhead">
            <span className="eyebrow">{t("llmServer.spillTitle")}</span>
            {errors != null && errors > 0 ? (
              <Tag tone="warn">{t("llmServer.spillErrors", { n: count(errors) })}</Tag>
            ) : null}
          </div>
          <div className="ls-meter">
            <i
              className={`ls-meter__fill ${storedShare != null && storedShare >= 0.9 ? "ls-meter__fill--warn" : "ls-meter__fill--info"}`}
              style={{ width: `${storedShare == null ? 0 : Math.max(0, Math.min(1, storedShare)) * 100}%` }}
            />
          </div>
          <div className="ls-cluster-metrics">
            <div className="ls-cluster-metric">
              <span>{t("llmServer.spillStored")}</span>
              <b>{gib(rank.storedBytes)}</b>
            </div>
            <div className="ls-cluster-metric">
              <span>{t("llmServer.spillCapacity")}</span>
              <b>{gib(rank.capacityBytes)}</b>
            </div>
            <div className="ls-cluster-metric">
              <span>{t("llmServer.spillDiskFree")}</span>
              <b>{gib(rank.diskFreeBytes)}</b>
            </div>
            <div className="ls-cluster-metric">
              <span>{t("llmServer.spillStaging")}</span>
              <b>{gib(rank.stagingBytes)}</b>
            </div>
            <div className="ls-cluster-metric">
              <span>{t("llmServer.spillWrites")}</span>
              <b>{count(rank.writesCommitted)}</b>
            </div>
            <div className="ls-cluster-metric">
              <span>{t("llmServer.spillReads")}</span>
              <b>{gib(rank.readBytes)}</b>
            </div>
            <div className="ls-cluster-metric">
              <span>{t("llmServer.spillPoints")}</span>
              <b>{count(rank.spillPoints)}</b>
            </div>
            <div className="ls-cluster-metric">
              <span>{t("llmServer.spillBlocks")}</span>
              <b>{count(rank.spillBlocks)}</b>
            </div>
            {rank.promptBytes != null ? (
              <div className="ls-cluster-metric">
                <span>{t("llmServer.rankPromptBytes")}</span>
                <b>{gib(rank.promptBytes)}</b>
              </div>
            ) : null}
            {rank.fetchRounds != null ? (
              <div className="ls-cluster-metric">
                <span>{t("llmServer.rankFetchRounds")}</span>
                <b>{count(rank.fetchRounds)}</b>
              </div>
            ) : null}
            {rank.copies != null ? (
              <div className="ls-cluster-metric">
                <span>{t("llmServer.rankCopies")}</span>
                <b>{count(rank.copies)}</b>
              </div>
            ) : null}
            {rank.transfersFailed != null ? (
              <div className="ls-cluster-metric">
                <span>{t("llmServer.transferFailed")}</span>
                <b>{count(rank.transfersFailed)}</b>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function pairState(cluster: LlmCluster): "healthy" | "stalled" | "broken" | "failed" | "unknown" {
  if (cluster.pair.broken === true) return "broken";
  if (cluster.pair.stalled === true) return "stalled";
  if (cluster.pair.failed != null && cluster.pair.failed > 0) return "failed";
  if (cluster.pair.stallMs != null) return "healthy";
  return "unknown";
}

export function LlmClusterPanel({ cluster }: { cluster: LlmCluster }) {
  const { t } = useTranslation("spark");
  const state = pairState(cluster);
  const pairLabel =
    state === "healthy"
      ? t("llmServer.pairHealthy")
      : state === "stalled"
        ? t("llmServer.pairStalled")
        : state === "broken"
          ? t("llmServer.pairBroken")
          : state === "failed"
            ? t("llmServer.pairFailed")
            : t("llmServer.pairUnknown");
  const pairTone = state === "broken" || state === "failed" ? "bad" : state === "stalled" ? "warn" : state === "healthy" ? "good" : "neutral";
  const ids = [...new Set([...cluster.partStats.map((p) => p.id), ...cluster.ranks.map((r) => r.id)])].sort(
    (a, b) => Number(a) - Number(b) || a.localeCompare(b),
  );
  const parts = cluster.parts ?? cluster.partStats.length;
  const transfer = cluster.transfer;

  return (
    <section className="ls-cluster" aria-label={t("llmServer.clusterTitle")}>
      <div className="ls-cluster__head">
        <div>
          <span className="eyebrow">{t("llmServer.clusterTitle")}</span>
          <p className="ls-cluster__sub">
            {t("llmServer.clusterSub", {
              parts,
              rows: count(cluster.partRows),
            })}
          </p>
        </div>
        <div className="ls-cluster__tags">
          <Tag tone={pairTone}>{pairLabel}</Tag>
          {cluster.pair.busyMs != null && cluster.pair.stallMs != null ? (
            <Tag tone="neutral">
              {t("llmServer.pairBusy", {
                busy: count(cluster.pair.busyMs),
                stall: count(cluster.pair.stallMs),
              })}
            </Tag>
          ) : null}
          {cluster.ranksReported != null ? (
            <Tag tone="info">
              {t("llmServer.ranksReported", {
                n: count(cluster.ranksReported),
                total: count(parts),
              })}
            </Tag>
          ) : null}
        </div>
      </div>

      <div className="ls-cluster__grid">
        {ids.map((id) => (
          <ClusterNode
            key={id}
            id={id}
            part={cluster.partStats.find((p) => p.id === id) ?? null}
            rank={cluster.ranks.find((r) => r.id === id) ?? null}
            partRows={cluster.partRows}
          />
        ))}
      </div>

      <div className="ls-cluster-transfer">
        <span className="eyebrow">{t("llmServer.transferTitle")}</span>
        <div className="ls-cluster-metrics">
          <div className="ls-cluster-metric">
            <span>{t("llmServer.transferPromptBytes")}</span>
            <b>{gib(transfer.promptBytes)}</b>
          </div>
          <div className="ls-cluster-metric">
            <span>{t("llmServer.transferFetchRounds")}</span>
            <b>{count(transfer.fetchRounds)}</b>
          </div>
          <div className="ls-cluster-metric">
            <span>{t("llmServer.transferCopies")}</span>
            <b>{count(transfer.copies)}</b>
          </div>
          <div className="ls-cluster-metric">
            <span>{t("llmServer.transferCarries")}</span>
            <b>{count(transfer.carries)}</b>
          </div>
          <div className="ls-cluster-metric">
            <span>{t("llmServer.transferMoves")}</span>
            <b>{count(transfer.moves)}</b>
          </div>
          <div className="ls-cluster-metric">
            <span>{t("llmServer.transferMovedTokens")}</span>
            <b>{count(transfer.movedTokens)}</b>
          </div>
          <div className="ls-cluster-metric">
            <span>{t("llmServer.transferFailed")}</span>
            <b>{count(transfer.transfersFailed)}</b>
          </div>
          <div className="ls-cluster-metric">
            <span>{t("llmServer.transferRefused")}</span>
            <b>{count(transfer.refusedNoTarget)}</b>
          </div>
        </div>
      </div>
    </section>
  );
}
