import type {
  ContainerInfo,
  CpuMetrics,
  DiskMetrics,
  GpuMetrics,
  MemMetrics,
  MemoryBudget,
  NetMetrics,
  NodeRole,
  RequestStats,
  ServiceInstance,
  TopologyInfo,
  VersionInfo,
} from "../../../shared/types";
import { MetricBar } from "../ui/MetricBar";
import { Panel } from "../ui/Panel";
import {
  ActivityIcon,
  BoltIcon,
  BotIcon,
  DiskIcon,
  MemoryIcon,
  NetworkIcon,
} from "../ui/icons";
import { formatAgo } from "../OverviewPage/FleetCard";

export interface NodeDetailProps {
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
  disk: DiskMetrics[];
  net: NetMetrics[];
  containers: ContainerInfo[];
  services: ServiceInstance[];
  versions: VersionInfo[];
  requests: RequestStats | null;
  topology: TopologyInfo | null;
  memory: MemoryBudget | null;
  polledAt: number;
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function formatUptime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

function formatMbps(mbps: number | null): string {
  if (mbps == null) return "—";
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(mbps % 1000 === 0 ? 0 : 1)} Gb/s`;
  return `${mbps} Mbps`;
}

function statusTone(status: string): "text-success" | "text-warning" | "text-danger" | "text-muted" {
  if (status === "running") return "text-success";
  if (status === "stopped" || status === "exited" || status === "wedged") return "text-danger";
  if (status === "loading") return "text-warning";
  return "text-muted";
}

/** Small key/value row used inside detail panels. */
function DetailRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted">{label}</span>
      <span className={`font-tabular truncate text-text ${tone ?? ""}`} title={value}>
        {value}
      </span>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-xs text-muted">{text}</p>;
}

/**
 * Per-node detail page: header + GPU/CPU/Mem/Disk/Net/Containers/Services/
 * Versions/Requests/Memory-budget/Topology panels. Data is the seam
 * NodeAgentSnapshot shape (shared/types.ts).
 */
export function NodeDetail(props: NodeDetailProps) {
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
    disk,
    net,
    containers,
    services,
    versions,
    requests,
    topology,
    memory,
    polledAt,
  } = props;

  const roleText = role === "head" ? "Head" : role === "worker" ? "Worker" : "Standalone";
  const temp = gpu?.temperature ?? 0;
  const tempBarColor = temp > 85 ? "bg-danger" : temp > 65 ? "bg-warning" : temp > 40 ? "bg-accent" : "bg-success";
  const usage = gpu?.usage ?? 0;
  const usageBarColor = usage > 85 ? "bg-danger" : usage > 60 ? "bg-warning" : "bg-accent";
  const vramUsed = gpu?.vramUsedMB ?? 0;
  const vramTotal = gpu?.vramTotalMB ?? 0;

  const memUsed = mem?.usedMB ?? 0;
  const memTotal = mem?.totalMB ?? 0;
  const memPct = mem?.percentage ?? (memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0);

  const reqs = requests?.stats ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${online ? "bg-success dot-glow-success" : "bg-danger"}`}
        />
        <h1 className="font-normal leading-tight tracking-tight text-text-strong" style={{ fontSize: "var(--density-overview-title)" }}>
          {nodeName}
        </h1>
        <span
          className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
          title={
            role === "head"
              ? "Cluster head"
              : role === "worker"
                ? rank != null
                  ? `Distributed LLM worker · rank ${rank}`
                  : "Distributed LLM worker"
                : "Standalone node"
          }
        >
          {roleText}
        </span>
        <span
          className="text-[10px] uppercase tracking-wide text-muted"
          data-testid="node-detail-status"
        >
          {online ? "online" : "offline"}
        </span>
        <span className="font-tabular text-xs text-muted">{lanIp}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted">
          {nodeId} · polled {formatAgo(polledAt)}
        </span>
      </div>

      {!online && (
        <div className="panel p-6 text-center text-sm text-muted">
          Host unreachable — showing last known values where available.
        </div>
      )}

      <div className="node-detail grid grid-cols-1 md:grid-cols-2" style={{ gap: "var(--density-page-gap)" }}>
        {/* GPU */}
        <Panel title="GPU" accent icon={<ActivityIcon />} bodyClassName="space-y-3">
          {gpu ? (
            <>
              <MetricBar label="Usage" value={usage} max={100} color={usageBarColor} caption={`${usage}%`} />
              <MetricBar
                label="Temperature"
                value={temp}
                max={100}
                color={tempBarColor}
                caption={`${temp}°C`}
              />
              <DetailRow label="Power" value={`${gpu.powerDraw}W / ${gpu.powerLimit}W`} />
              {vramTotal > 0 ? (
                <MetricBar
                  label="VRAM"
                  value={vramUsed}
                  max={vramTotal}
                  caption={`${formatMb(vramUsed).replace(/ (GB|MB)$/, "")} / ${formatMb(vramTotal)}`}
                />
              ) : (
                <DetailRow label="VRAM" value={vramUsed > 0 ? `${formatMb(vramUsed)} used` : "—"} />
              )}
              {gpu.vramAvailableMB > 0 && (
                <DetailRow label="VRAM available" value={formatMb(gpu.vramAvailableMB)} />
              )}
              {gpu.processes.length > 0 && (
                <div className="space-y-1.5 border-t border-border pt-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted">Processes</div>
                  {gpu.processes.map((proc) => (
                    <div key={proc.pid} className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="min-w-0 truncate text-text" title={`${proc.name} (PID ${proc.pid})`}>
                          {proc.name}
                        </span>
                        <span className="shrink-0 font-tabular text-[10px] text-muted">{proc.pid}</span>
                      </div>
                      <span className="shrink-0 font-tabular text-text">{formatMb(proc.vramMB)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <EmptyNote text="No GPU metrics" />
          )}
        </Panel>

        {/* CPU */}
        <Panel title="CPU" icon={<BoltIcon />} bodyClassName="space-y-3">
          {cpu ? (
            <>
              <MetricBar
                label="Usage"
                value={cpu.usage}
                max={100}
                caption={`${cpu.usage}%`}
              />
              <DetailRow label="Temperature" value={`${cpu.temperature}°C`} />
              <DetailRow label="Draw" value={`${cpu.draw}W`} />
              <DetailRow label="TDP" value={`${cpu.tdp}W`} />
            </>
          ) : (
            <EmptyNote text="No CPU metrics" />
          )}
        </Panel>

        {/* Mem */}
        <Panel title="Mem" icon={<MemoryIcon />} bodyClassName="space-y-3">
          {mem && memTotal > 0 ? (
            <>
              <MetricBar
                label="Mem"
                value={memUsed}
                max={memTotal}
                caption={`${formatMb(memUsed).replace(/ (GB|MB)$/, "")} / ${formatMb(memTotal)} (${memPct}%)`}
              />
              <DetailRow label="Available" value={formatMb(mem.availableMB)} />
            </>
          ) : (
            <EmptyNote text="No memory metrics" />
          )}
        </Panel>

        {/* Disk */}
        <Panel title="Disk" accent icon={<DiskIcon />} bodyClassName="space-y-3.5">
          {disk.length === 0 ? (
            <EmptyNote text="No mounted disks" />
          ) : (
            disk.map((d) => (
              <div key={d.mount} className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-xs text-text">{d.mount}</span>
                    <span className="shrink-0 font-tabular text-xs text-muted">{d.device}</span>
                  </div>
                  <span className="shrink-0 font-tabular text-xs text-text-strong">{d.percentage}%</span>
                </div>
                <MetricBar label="" value={d.usedMB} max={d.totalMB} caption="" />
                <div className="flex items-center justify-between text-xs">
                  <span className="font-tabular text-muted">
                    {formatMb(d.usedMB)} / {formatMb(d.totalMB)}
                  </span>
                  <span className="font-tabular text-muted">{formatMb(d.availableMB)} free</span>
                </div>
              </div>
            ))
          )}
        </Panel>

        {/* Net */}
        <Panel title="Network" icon={<NetworkIcon />} bodyClassName="space-y-2">
          {net.length === 0 ? (
            <EmptyNote text="No interfaces" />
          ) : (
            net.map((n) => (
              <div key={n.iface} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs">
                <span className="font-medium text-text">{n.iface}</span>
                <span className="font-tabular text-muted">{n.ip ?? "no ip"}</span>
                <span className="font-tabular text-muted" title="RX">
                  ↓ {n.rxSpeed.toFixed(1)} MB/s
                </span>
                <span className="font-tabular text-muted" title="TX">
                  ↑ {n.txSpeed.toFixed(1)} MB/s
                </span>
                <span className="font-tabular text-muted">{formatMbps(n.linkSpeedMbps)}</span>
              </div>
            ))
          )}
        </Panel>

        {/* Containers */}
        <Panel title="Containers" icon={<BotIcon />} bodyClassName="space-y-2">
          {containers.length === 0 ? (
            <EmptyNote text="No containers" />
          ) : (
            containers.map((c) => (
              <div
                key={c.name}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs"
              >
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-medium text-text" title={c.name}>
                    {c.name}
                  </span>
                  <span className="truncate text-muted" title={c.image}>
                    {c.image}
                  </span>
                </div>
                <span className={`font-medium ${statusTone(c.status)}`}>{c.status}</span>
                <span className="font-tabular text-muted" title="Uptime">
                  {formatUptime(c.uptimeSeconds)}
                </span>
                <span className="max-w-40 truncate font-tabular text-muted" title={c.ports.join(", ") || "no ports"}>
                  {c.ports.length > 0 ? c.ports.join(", ") : "—"}
                </span>
                <span className="font-tabular text-text">{c.memUsedMB != null ? formatMb(c.memUsedMB) : "—"}</span>
              </div>
            ))
          )}
        </Panel>

        {/* Services */}
        <Panel title="Services" bodyClassName="space-y-2">
          {services.length === 0 ? (
            <EmptyNote text="No services" />
          ) : (
            services.map((s) => (
              <div
                key={`${s.name}:${s.port}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs"
              >
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-medium text-text" title={s.name}>
                    {s.name}
                  </span>
                  {s.active && (
                    <span className="shrink-0 rounded bg-accent/15 px-1 text-[9px] font-medium uppercase tracking-wide text-accent">
                      active
                    </span>
                  )}
                </div>
                <span className="text-muted">{s.kind || "—"}</span>
                <span className="font-tabular text-muted">{s.engine}</span>
                <span className="font-tabular text-muted">:{s.port}</span>
                <span className={`font-medium ${statusTone(s.status)}`}>{s.status}</span>
                <span className="max-w-40 truncate text-muted" title={s.modelId ?? "no model"}>
                  {s.modelId ?? "—"}
                </span>
                <span className="font-tabular text-muted">{s.engineVersion ?? "—"}</span>
                <span className="font-tabular text-text">{formatMb(s.footprintMB)}</span>
              </div>
            ))
          )}
        </Panel>

        {/* Versions */}
        <Panel title="Versions" bodyClassName="space-y-2">
          {versions.length === 0 ? (
            <EmptyNote text="No version info" />
          ) : (
            versions.map((v) => (
              <div
                key={`${v.serviceName}:${v.port}`}
                className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="font-medium text-text">{v.serviceName}</span>
                  <span className="text-muted">{v.kind}</span>
                  <span className="font-tabular text-muted">
                    {v.engine}
                    {v.engineVersion ? ` ${v.engineVersion}` : ""}
                  </span>
                  <span className={`font-medium ${statusTone(v.state)}`}>{v.state}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="max-w-56 truncate text-muted" title={v.modelPath ?? v.modelId ?? undefined}>
                    {v.modelId ?? "no model"}
                    {v.modelPath ? ` (${v.modelPath})` : ""}
                  </span>
                  <span className="font-tabular text-muted">
                    ctx {v.contextLength != null ? v.contextLength.toLocaleString() : "—"}
                  </span>
                  <span className="font-tabular text-muted">mem {v.memFraction != null ? v.memFraction : "—"}</span>
                  <span className="font-tabular text-muted">tp {v.tpSize ?? "—"}</span>
                  <span className="font-tabular text-muted">:{v.port}</span>
                </div>
              </div>
            ))
          )}
        </Panel>

        {/* Requests */}
        <Panel title="Requests" bodyClassName="space-y-2">
          {reqs.length === 0 ? (
            <EmptyNote text="No request stats" />
          ) : (
            reqs.map((r) => (
              <div
                key={`${r.nodeId}:${r.port}:${r.modelId}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs"
              >
                <span className="max-w-48 truncate font-medium text-text" title={r.modelId}>
                  {r.modelId}
                </span>
                <span className="font-tabular text-muted">{r.engine}</span>
                <span className="font-tabular text-muted">:{r.port}</span>
                <span className="font-tabular text-muted" title="queued">
                  q {r.queued}
                </span>
                <span className="font-tabular text-success" title="running">
                  r {r.running}
                </span>
                <span className="font-tabular text-text" title="finished">
                  f {r.finished}
                </span>
              </div>
            ))
          )}
        </Panel>

        {/* Memory budget */}
        <Panel title="Memory Budget" icon={<MemoryIcon />} bodyClassName="space-y-3">
          {memory ? (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <DetailRow label="Total" value={formatMb(memory.totalMB)} />
                <DetailRow label="Used" value={formatMb(memory.usedMB)} />
                <DetailRow label="Free" value={formatMb(memory.freeMB)} />
                <DetailRow label="Services used" value={formatMb(memory.servicesUsedMB)} />
                <DetailRow label="Other used" value={formatMb(memory.otherUsedMB)} />
              </div>
              {memory.needMakeRoom && (
                <div className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger">
                  Make room needed
                </div>
              )}
              {memory.makeRoom.length > 0 && (
                <div className="space-y-1.5 border-t border-border pt-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted">Make-room plan</div>
                  {memory.makeRoom.map((m) => (
                    <div key={m.serviceName} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-text" title={m.reason}>
                        {m.serviceName}
                      </span>
                      <span className="font-tabular text-muted" title={m.reason}>
                        frees {formatMb(m.freesMB)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {memory.services.length > 0 && (
                <div className="space-y-1.5 border-t border-border pt-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted">Services</div>
                  {memory.services.map((s) => (
                    <div key={s.name} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-text">
                        {s.name}
                        {s.running ? "" : " (stopped)"}
                      </span>
                      <span className="font-tabular text-muted">{formatMb(s.footprintMB)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <EmptyNote text="No memory budget" />
          )}
        </Panel>

        {/* Topology */}
        <Panel title="Topology" icon={<NetworkIcon />} bodyClassName="space-y-2">
          {topology ? (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <DetailRow label="Role" value={topology.role} />
                <DetailRow label="Rank" value={topology.rank != null ? String(topology.rank) : "—"} />
                <DetailRow label="Group" value={topology.groupId ?? "—"} />
                <DetailRow label="Head" value={topology.headId ?? "—"} />
              </div>
              {topology.links.length > 0 ? (
                <div className="space-y-1.5 border-t border-border pt-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted">Links</div>
                  {topology.links.map((l, i) => (
                    <div
                      key={`${l.from}:${l.to}:${i}`}
                      className={`flex items-center justify-between gap-2 text-xs ${l.up ? "" : "opacity-60"}`}
                    >
                      <span className="truncate text-text">
                        {l.from} ⇄ {l.to}
                      </span>
                      <span className="font-tabular text-muted">
                        {l.speedMbps != null ? formatMbps(l.speedMbps) : "speed ?"} · {l.transport} ·{" "}
                        {l.up ? "up" : "down"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyNote text="No RoCE links" />
              )}
            </>
          ) : (
            <EmptyNote text="No topology info" />
          )}
        </Panel>
      </div>
    </div>
  );
}
