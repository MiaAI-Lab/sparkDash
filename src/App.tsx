import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useSnapshot } from "./hooks/useSnapshot";
import { useAppRoute, useRoute } from "./hooks/useRoute";
import { fetchSparks, reorderSparks, fetchSettings, fetchSessionSources } from "./api/client";
import { SparkTabs } from "./components/SparkTabs";
import { AddSparkDialog } from "./components/AddSparkDialog";
import { EditSparkDialog } from "./components/EditSparkDialog";
import { SparkPage } from "./components/SparkPage/SparkPage";
import { HermesUpdateDialog } from "./components/SparkPage/HermesUpdateDialog";
import { OverviewPage } from "./components/OverviewPage/OverviewPage";
import { ShowcasePage } from "./components/ShowcasePage/ShowcasePage";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { SettingsDialog } from "./components/SettingsDialog";
import { HarnessWizard } from "./components/HarnessWizard";
import { GearIcon, BoltIcon, BotIcon } from "./components/ui/icons";
import { OVERVIEW_ID } from "./constants";
import type { Settings, SparkSnapshot } from "./api/types";

function placeholderSnapshot(
  id: string,
  name: string,
  disabledDevices: string[] = [],
  disabledInterfaces: string[] = [],
  llmPorts: number[] = [8888],
  roleFields?: {
    role?: SparkSnapshot["role"];
    workerNode?: boolean;
    workerLabel?: string | null;
    workerHeadId?: string | null;
    llmMonitoring?: boolean;
    comfyMonitoring?: boolean;
    comfyPort?: number;
    tailscaleMonitoring?: boolean;
    kind?: "spark" | "host";
  }
): SparkSnapshot {
  const role =
    roleFields?.role === "head" ||
    roleFields?.role === "worker" ||
    roleFields?.role === "standalone"
      ? roleFields.role
      : roleFields?.workerNode
        ? "worker"
        : "standalone";
  const workerNode = role === "worker";
  return {
    id,
    name,
    kind: roleFields?.kind ?? "spark",
    online: false,
    uptime: null,
    disabledDevices,
    disabledInterfaces,
    llmPort: llmPorts[0] ?? 8888,
    llmPorts,
    workerNode,
    role,
    workerLabel: workerNode ? roleFields?.workerLabel ?? null : null,
    workerHeadId: workerNode ? roleFields?.workerHeadId ?? null : null,
    llmMonitoring:
      role === "worker"
        ? false
        : role === "head"
          ? true
          : roleFields?.llmMonitoring !== false,
    comfyMonitoring: Boolean(roleFields?.comfyMonitoring),
    comfyPort: roleFields?.comfyPort ?? 8188,
    tailscaleMonitoring: Boolean(roleFields?.tailscaleMonitoring),
    hermes: {
      monitoring: false,
      installed: null,
      version: null,
      updateAvailable: null,
      behindCommits: null,
      checkedAt: null,
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
    },
    hardware: {
      device: "NVIDIA DGX Spark",
      cpuModel: "…",
      cpuCores: 0,
      totalMemoryGB: 0,
      gpuChip: "…",
      cudaDriver: null,
      storageModel: null,
    },
    metrics: {
      gpu: null,
      cpu: null,
      ram: null,
      storage: [],
      network: null,
      unifiedMemory: null,
      llm: [],
      comfy: null,
      tailscale: null,
    },
  };
}

function DashboardApp() {
  const { sparks, activeId, setActiveId, activeSpark, connected } = useSnapshot();
  const navigate = useRoute(setActiveId);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showHarnessWizard, setShowHarnessWizard] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  /** Used when WS is down so add/delete still updates the tab bar */
  const [fallbackSparks, setFallbackSparks] = useState<SparkSnapshot[]>([]);
  const didFirstRunCheck = useRef(false);

  // Prefer live WS data; fall back to API-fetched list when empty
  const liveSparks = sparks.length > 0 ? sparks : fallbackSparks;
  /** Optimistic tab order while drag-save races the next WS snapshot */
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);

  const displaySparks = useMemo(() => {
    if (!orderOverride?.length) return liveSparks;
    const map = new Map(liveSparks.map((s) => [s.id, s]));
    const ordered: SparkSnapshot[] = [];
    for (const id of orderOverride) {
      const s = map.get(id);
      if (s) {
        ordered.push(s);
        map.delete(id);
      }
    }
    for (const s of map.values()) ordered.push(s);
    return ordered;
  }, [liveSparks, orderOverride]);

  // Drop override once server/WS order matches
  useEffect(() => {
    if (!orderOverride) return;
    const live = liveSparks.map((s) => s.id).join("\0");
    if (live === orderOverride.join("\0")) setOrderOverride(null);
  }, [liveSparks, orderOverride]);


  const isOverview = activeId === OVERVIEW_ID;
  const displayActive = isOverview
    ? null
    : displaySparks.find((s) => s.id === activeId) || displaySparks[0] || activeSpark || null;

  useEffect(() => {
    if (sparks.length > 0) setFallbackSparks([]);
  }, [sparks]);

  // Fetch global settings on mount
  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch((err) => console.error("Failed to fetch settings:", err));
  }, []);

  // First-run auto-open: open the harness wizard when zero harnesses are connected
  // AND at least one Spark exists. Don't show harness onboarding to a user who
  // hasn't added any Spark yet — they need a Spark before harnesses matter.
  useEffect(() => {
    if (didFirstRunCheck.current) return;
    if (liveSparks.length === 0) return;
    didFirstRunCheck.current = true;
    fetchSessionSources()
      .then((sources) => {
        const hasEnabled = Object.values(sources).some((attaches) =>
          attaches.some((a) => a.enabled)
        );
        if (!hasEnabled) setShowHarnessWizard(true);
      })
      .catch(() => {
        // If we can't load sources, don't auto-open — user can open manually
      });
  }, [liveSparks]);

  const handleSettingsSaved = useCallback((s: Settings) => {
    setSettings(s);
  }, []);

  // Apply layout density (comfortable/compact) from persisted settings.
  useEffect(() => {
    if (settings?.density) {
      document.documentElement.setAttribute("data-density", settings.density);
    }
  }, [settings?.density]);

  const refreshFromApi = useCallback(async () => {
    try {
      const { sparks: configs } = await fetchSparks();
      setFallbackSparks(
        configs.map((c) => {
          const existing = sparks.find((s) => s.id === c.id);
          if (existing) {
            // Keep live metrics, but never let a stale WS snapshot override
            // role fields that were just saved via the API.
            return {
              ...existing,
              name: c.name,
              role: c.role ?? existing.role,
              workerNode: c.workerNode ?? existing.workerNode,
              workerLabel: c.workerLabel ?? existing.workerLabel,
              workerHeadId: c.workerHeadId ?? existing.workerHeadId,
              llmMonitoring: c.llmMonitoring ?? existing.llmMonitoring,
              comfyMonitoring: c.comfyMonitoring ?? existing.comfyMonitoring,
              comfyPort: c.comfyPort ?? existing.comfyPort,
              tailscaleMonitoring: c.tailscaleMonitoring ?? existing.tailscaleMonitoring,
              disabledDevices: c.disabledDevices || existing.disabledDevices,
              disabledInterfaces: c.disabledInterfaces || existing.disabledInterfaces,
              llmPorts: c.llmPorts ?? existing.llmPorts,
              llmPort: c.llmPorts?.[0] ?? c.llmPort ?? existing.llmPort,
              kind: c.kind ?? existing.kind,
            };
          }
          return placeholderSnapshot(
            c.id,
            c.name,
            c.disabledDevices || [],
            c.disabledInterfaces || [],
            c.llmPorts ?? (c.llmPort ? [c.llmPort] : [8888]),
            {
              role: c.role,
              workerNode: c.workerNode,
              workerLabel: c.workerLabel,
              workerHeadId: c.workerHeadId,
              llmMonitoring: c.llmMonitoring,
              comfyMonitoring: c.comfyMonitoring,
              comfyPort: c.comfyPort,
              tailscaleMonitoring: c.tailscaleMonitoring,
              kind: c.kind,
            }
          );
        })
      );
      if (configs.length && activeId !== OVERVIEW_ID && !configs.some((c) => c.id === activeId)) {
        setActiveId(configs[0].id);
      }
      if (configs.length === 0 && activeId !== OVERVIEW_ID) setActiveId(null);
    } catch (err) {
      console.error("Failed to refresh sparks:", err);
    }
  }, [sparks, activeId, setActiveId]);

  const handleReorder = useCallback(async (orderedIds: string[]) => {
    setOrderOverride(orderedIds);
    try {
      await reorderSparks(orderedIds);
    } catch (err) {
      console.error("Failed to reorder Sparks:", err);
      setOrderOverride(null);
    }
  }, []);

  return (
    <div className="min-h-screen p-0 text-text sm:p-8">
      <div className="dashboard-shell">
        <header className="flex flex-wrap items-center gap-3" style={{ marginBottom: "var(--density-header-gap)" }}>
          <button
            type="button"
            onClick={() => navigate(OVERVIEW_ID)}
            className="logo-pill"
          >
            <BoltIcon className="h-3.5 w-3.5 text-accent" />
            <span>
              spark<span className="logo-pill-dash">Dash</span>
            </span>
          </button>
          <SparkTabs
            sparks={displaySparks}
            activeId={displayActive?.id ?? activeId}
            onSelect={navigate}
            onAdd={() => setShowAdd(true)}
            onEdit={(id) => setEditId(id)}
            onReorder={handleReorder}
          />
          <div className="ml-auto flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowHarnessWizard(true)}
              className="icon-circle"
              title="Harnesses"
              aria-label="Manage harnesses"
            >
              <BotIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="icon-circle"
              title="Settings"
              aria-label="Settings"
            >
              <GearIcon className="h-4 w-4" />
            </button>
            <ThemeSwitch />
          </div>
        </header>
        <main>
          {isOverview ? (
            <OverviewPage
              sparks={displaySparks}
              hideOffline={settings?.autoHideOffline ?? false}
              temperatureUnit={settings?.temperatureUnit ?? "celsius"}
              onSelectSpark={navigate}
            />
          ) : displayActive ? (
            <SparkPage
              spark={displayActive}
              temperatureUnit={settings?.temperatureUnit ?? "celsius"}
              onEdit={() => setEditId(displayActive.id)}
              onOpenHarnessWizard={() => setShowHarnessWizard(true)}
            />
          ) : (
            <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
              <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
                <span className="text-lg leading-none">+</span>
              </div>
              <h2 className="text-sm font-semibold text-text-strong">No Spark registered</h2>
              <p className="mt-1 text-xs text-muted">
                Click the&nbsp;
                <span className="rounded border border-border bg-surface-elevated px-1 py-0.5 text-text">+</span>
                &nbsp;tab to add a DGX Spark unit.
              </p>
            </div>
          )}
        </main>
      </div>
      <HermesUpdateDialog />
      <AddSparkDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => {
          void refreshFromApi();
        }}
        defaultLlmPort={settings?.defaultLlmPort ?? 8888}
      />
      <EditSparkDialog
        open={editId != null}
        sparkId={editId}
        onClose={() => setEditId(null)}
        onSaved={() => {
          void refreshFromApi();
        }}
        onDeleted={(id) => {
          if (activeId === id) {
            const next = displaySparks.find((s) => s.id !== id);
            navigate(next?.id ?? OVERVIEW_ID);
          }
          void refreshFromApi();
        }}
      />
      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onSaved={handleSettingsSaved}
      />
      <HarnessWizard
        open={showHarnessWizard}
        onClose={() => setShowHarnessWizard(false)}
        onSaved={() => {
          void refreshFromApi();
        }}
      />
    </div>
  );
}

function App() {
  const route = useAppRoute();
  if (route.mode === "showcase" && route.showcaseSparkId) {
    return <ShowcasePage sparkId={route.showcaseSparkId} />;
  }
  return <DashboardApp />;
}

export default App;
