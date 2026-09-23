import type {
  ContainerInfo,
  CpuMetrics,
  GpuMetrics,
  MemMetrics,
  MemoryBudget,
  NodeRole,
  RequestStats,
  ServiceInstance,
  TopologyInfo,
  VersionInfo,
} from "../../../shared/types";
import { MetricBar } from "../ui/MetricBar";

export interface FleetCardProps {
  nodeId: string;
  nodeName: string;
  lanIp: string;
  role: NodeRole;
  rank: number | null;
  groupId: string | null;
  online: boolean;
  gpu: GpuMetrics | null;
  cpu: CpuMetrics | null;
  mem: MemMetrics | null;
  containers: ContainerInfo[];
  services: ServiceInstance[];
  versions: VersionInfo[];
  requests: RequestStats | null;
  topology: TopologyInfo | null;
  memory: MemoryBudget | null;
  polledAt: number;
}

/**
 * Human "x ago" label for a ms-epoch timestamp. Buckets: <10s "just now",
 * <60s seconds, <60m minutes, <24h hours, else days.
 */
export function formatAgo(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function roleBadgeText(role: NodeRole): string {
  return role === "head" ? "Head" : role === "worker" ? "Worker" : "Standalone";
}

function roleBadgeTitle(role: NodeRole, groupId: string | null, rank: number | null): string {
  if (role === "head") return groupId ? `Cluster head · group ${groupId}` : "Cluster head";
  if (role === "worker")
    return rank != null ? `Distributed LLM worker · rank ${rank}${groupId ? ` · ${groupId}` : ""}` : "Distributed LLM worker";
  return "Standalone node";
}

function MiniStat({
  label,
  value,
  tone = "default",
  title,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "warning" | "danger" | "success";
  title?: string;
}) {
  const toneClass =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "accent"
          ? "text-accent"
          : tone === "success"
            ? "text-success"
            : "text-text";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] tracking-wide text-muted">{label}</span>
      <span className={`font-tabular truncate text-[13px] font-semibold ${toneClass}`} title={title}>
        {value}
      </span>
    </div>
  );
}

/**
 * One fleet card in the fleet overview grid — one per node.
 * Header (name/role/status), GPU/CPU/VRAM/mem bars, container/service/request
 * counts, memory budget, and last-poll age.
 */
export function FleetCard(props: FleetCardProps) {
  const {
    nodeId,
    nodeName,
    lanIp,
    role,
    rank,
    groupId,
    online,
    gpu,
    cpu,
    mem,
    containers,
    services,
    requests,
    memory,
    polledAt,
  } = props;

  const usage = gpu?.usage ?? 0;
  const temp = gpu?.temperature ?? 0;
  const usageBarColor = usage > 85 ? "bg-danger" : usage > 60 ? "bg-warning" : "bg-accent";
  const tempBarColor = temp > 85 ? "bg-danger" : temp > 65 ? "bg-warning" : temp > 40 ? "bg-accent" : "bg-success";
  const vramUsed = gpu?.vramUsedMB ?? 0;
  const vramTotal = gpu?.vramTotalMB ?? 0;
  const vramPct = gpu?.vramPercentage ?? (vramTotal > 0 ? Math.round((vramUsed / vramTotal) * 100) : 0);
  const vramBarColor = vramPct > 85 ? "bg-danger" : vramPct > 60 ? "bg-warning" : "bg-accent";

  const cpuUsage = cpu?.usage ?? 0;
  const cpuTemp = cpu?.temperature ?? 0;

  const memUsed = mem?.usedMB ?? 0;
  const memTotal = mem?.totalMB ?? 0;
  const memPct = mem?.percentage ?? (memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0);

  const runningContainers = containers.filter((c) => c.status === "running").length;
  const stoppedContainers = containers.length - runningContainers;

  const activeServices = services.filter((s) => s.active).length;
  const runningServices = services.filter((s) => s.status === "running").length;

  const reqs = requests?.stats ?? [];
  const queued = reqs.reduce((n, r) => n + r.queued, 0);
  const running = reqs.reduce((n, r) => n + r.running, 0);
  const finished = reqs.reduce((n, r) => n + r.finished, 0);

  return (
    <div
      aria-label={`Fleet node ${nodeName}`}
      className="overview-card flex flex-col"
      style={{
        padding: "var(--density-card-pad)",
        gap: "var(--density-card-gap)",
        ...(online ? {} : { opacity: 0.6 }),
      }}
    >
      {/* Card header */}
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-success dot-glow-success" : "bg-danger"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-strong" title={nodeId}>
          {nodeName}
        </span>
        <span
          className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
          title={roleBadgeTitle(role, groupId, rank)}
        >
          {roleBadgeText(role)}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted" data-testid="fleet-card-status">
          {online ? "online" : "offline"}
        </span>
      </div>

      <div className="text-[10px] font-tabular text-muted">
        {lanIp}
        {rank != null ? ` · rank ${rank}` : ""}
        {groupId ? ` · ${groupId}` : ""}
      </div>

      {!online || (!gpu && !cpu && !mem) ? (
        <div className="flex h-[120px] items-center justify-center">
          <span className="text-[13px] text-muted">
            {online ? "Waiting for metrics…" : "Host unreachable"}
          </span>
        </div>
      ) : (
        <>
          {/* Headline bars */}
          <div className="flex flex-col gap-3.5">
            <MetricBar
              label="VRAM"
              value={vramUsed}
              max={vramTotal}
              color={vramBarColor}
              caption={vramTotal > 0 ? `${formatMb(vramUsed).replace(/ (GB|MB)$/, "")} / ${formatMb(vramTotal)}` : "—"}
            />
            {mem && (
              <MetricBar
                label="Mem"
                value={memUsed}
                max={memTotal}
                caption={memTotal > 0 ? `${formatMb(memUsed).replace(/ (GB|MB)$/, "")} / ${formatMb(memTotal)}` : "—"}
              />
            )}
            <MetricBar
              label="GPU"
              value={temp}
              max={100}
              color={tempBarColor}
              caption={`${temp}°C`}
            />
            <MetricBar label="Usage" value={usage} max={100} color={usageBarColor} caption={`${usage}%`} />
          </div>

          {/* Secondary stats */}
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border pt-3.5">
            <MiniStat label="GPU Power" value={`${gpu?.powerDraw ?? 0}W / ${gpu?.powerLimit ?? 0}W`} />
            <MiniStat
              label="CPU"
              value={`${cpuUsage}% · ${cpuTemp}°C`}
              tone={cpuTemp > 95 ? "danger" : cpuTemp > 85 ? "warning" : "default"}
              title="CPU usage · temperature"
            />
            <MiniStat
              label="Containers"
              value={`${containers.length} (${runningContainers} running)`}
              title={
                containers.length > 0
                  ? containers.map((c) => `${c.name} [${c.status}]`).join("\n")
                  : "No containers"
              }
            />
            <MiniStat
              label="Services"
              value={`${services.length} (${runningServices} active)`}
              title={
                services.length > 0
                  ? services.map((s) => `${s.name} [${s.status}]${s.active ? " · active" : ""}`).join("\n")
                  : "No services"
              }
            />
            <MiniStat
              label="Requests"
              value={`q${queued} · r${running} · f${finished}`}
              title="queued · running · finished"
            />
            {memory && (
              <MiniStat
                label="Mem Budget"
                value={`${formatMb(memory.freeMB)} free`}
                tone={memory.needMakeRoom ? "danger" : memory.freeMB < 8192 ? "warning" : "success"}
                title={`total ${formatMb(memory.totalMB)} · used ${formatMb(memory.usedMB)}`}
              />
            )}
            {memory?.needMakeRoom && (
              <div
                className="col-span-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger"
                title={
                  memory.makeRoom.length > 0
                    ? `Stop to free memory: ${memory.makeRoom.map((m) => `${m.serviceName} (${formatMb(m.freesMB)})`).join(", ")}`
                    : "Free memory below target — a make-room plan is needed"
                }
              >
                Make room needed
                {memory.makeRoom.length > 0
                  ? ` — stop: ${memory.makeRoom.map((m) => m.serviceName).join(", ")}`
                  : ""}
              </div>
            )}
          </div>
        </>
      )}

      {/* Footer: last poll */}
      <div className="flex items-center justify-between border-t border-border pt-2 text-[10px] uppercase tracking-wide text-muted">
        <span data-testid="fleet-card-polledat">Polled {formatAgo(polledAt)}</span>
        <span className="font-tabular">{nodeId}</span>
      </div>
    </div>
  );
}
