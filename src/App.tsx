import { BenchIcon } from "./components/bench/BenchIcon";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useSnapshot } from "./hooks/useSnapshot";
import { useAppRoute, useRoute } from "./hooks/useRoute";
import { fetchSparks, reorderSparks, fetchSettings } from "./api/client";
import { AppSidebar } from "./components/shell/AppSidebar";
import { MobileTabBar } from "./components/shell/MobileTabBar";
import { CommandPalette, type PaletteCommand } from "./components/shell/CommandPalette";
import { openShowcase, showcaseTarget } from "./components/shell/sparkSummary";
import { AddSparkDialog } from "./components/AddSparkDialog";
import { EditSparkDialog } from "./components/EditSparkDialog";
import { SparkPage } from "./components/SparkPage/SparkPage";
import { HermesUpdateDialog } from "./components/SparkPage/HermesUpdateDialog";
import { OverviewPage } from "./components/OverviewPage/OverviewPage";
import { ShowcasePage } from "./components/ShowcasePage/ShowcasePage";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  GearIcon,
  GridIcon,
  PlusIcon,
  EditIcon,
  SearchIcon,
  TerminalIcon,
  SunIcon,
  ServerIcon,
  BoltIcon,
  ListIcon,
  PanelLeftIcon,
  TokensIcon,
} from "./components/ui/icons";
import { ConnectionBanner } from "./components/ui/ConnectionBanner";
import { ErrorBanner } from "./components/ui/ErrorBanner";
import {
  ACTIVITY_ID,
  ENERGY_ID,
  OVERVIEW_ID,
  TOKENS_ID,
  benchId,
  benchTypeOf,
  isPageId,
} from "./constants";
import { TokensPage } from "./components/TokensPage/TokensPage";
import { EnergyPage } from "./components/EnergyPage/EnergyPage";
import { ActivityPage } from "./components/ActivityPage/ActivityPage";
import { BenchPage } from "./components/bench/BenchPage";
import { BENCH_SPARK_KEY, BENCH_TYPES } from "./components/bench/benchCatalog";
import type { Settings, SparkSnapshot } from "./api/types";
import { isWorkerSpark } from "./api/sparkRole";

/** Keep hidden worker ids in their original slots when the visible tabs are reordered. */
function mergeTabOrderKeepingHidden(
  allSparks: SparkSnapshot[],
  visibleOrder: string[],
  hiddenIds: Set<string>
): string[] {
  if (hiddenIds.size === 0) return visibleOrder;
  const result: string[] = [];
  let vi = 0;
  for (const spark of allSparks) {
    if (hiddenIds.has(spark.id)) {
      result.push(spark.id);
    } else if (vi < visibleOrder.length) {
      result.push(visibleOrder[vi++]);
    }
  }
  while (vi < visibleOrder.length) result.push(visibleOrder[vi++]);
  return result;
}

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
  const {
    sparks,
    activeId,
    setActiveId,
    activeSpark,
    connected,
    lastValidSnapshotAt,
    snapshotError,
    refreshInterval,
  } = useSnapshot();
  const [telemetryNow, setTelemetryNow] = useState(Date.now());
  const navigate = useRoute(setActiveId);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // Desktop sidebar can be hidden to give the page the full width; remembered per browser.
  const [sideHidden, setSideHidden] = useState(() => {
    try {
      return localStorage.getItem("sparkdash.sidebar.hidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSideHidden((v) => {
      const next = !v;
      try {
        localStorage.setItem("sparkdash.sidebar.hidden", next ? "1" : "0");
      } catch {
        /* storage blocked: it still toggles for this session */
      }
      return next;
    });
  }, []);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Used when WS is down so add/delete still updates the tab bar */
  const [fallbackSparks, setFallbackSparks] = useState<SparkSnapshot[]>([]);
  const staleAfterMs = Math.max(10_000, 3 * (refreshInterval ?? 2_000));
  const telemetryStale =
    lastValidSnapshotAt != null && telemetryNow - lastValidSnapshotAt > staleAfterMs;

  useEffect(() => {
    if (lastValidSnapshotAt == null) return;
    setTelemetryNow(Date.now());
    const timer = window.setInterval(() => setTelemetryNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [lastValidSnapshotAt]);

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
  const onPage = isPageId(activeId);
  const benchType = benchTypeOf(activeId);
  const hideWorkers = settings?.hideWorkers ?? false;
  const hiddenWorkerIds = useMemo(() => {
    if (!hideWorkers) return new Set<string>();
    return new Set(
      displaySparks
        .filter((s) => isWorkerSpark(s) && s.id !== activeId)
        .map((s) => s.id)
    );
  }, [displaySparks, hideWorkers, activeId]);
  const tabSparks = useMemo(
    () => (hideWorkers ? displaySparks.filter((s) => !hiddenWorkerIds.has(s.id)) : displaySparks),
    [displaySparks, hideWorkers, hiddenWorkerIds]
  );
  const displayActive = onPage
    ? null
    : displaySparks.find((s) => s.id === activeId) || displaySparks[0] || activeSpark || null;

  useEffect(() => {
    if (sparks.length > 0) setFallbackSparks([]);
  }, [sparks]);

  // Fetch global settings on mount
  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch((err) =>
        setActionError(
          `Could not load settings: ${err instanceof Error ? err.message : String(err)}. Reload to retry.`
        )
      );
  }, []);

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
      if (configs.length && activeId !== OVERVIEW_ID && !isPageId(activeId) && !configs.some((c) => c.id === activeId)) {
        setActiveId(configs[0].id);
      }
      if (configs.length === 0 && activeId !== OVERVIEW_ID && !isPageId(activeId)) setActiveId(null);
    } catch (err) {
      console.error("Failed to refresh sparks:", err);
      setActionError(
        `Could not refresh Sparks: ${err instanceof Error ? err.message : String(err)}. Previous data remains visible.`
      );
    }
  }, [sparks, activeId, setActiveId]);

  const handleReorder = useCallback(
    async (orderedIds: string[]) => {
      const next = mergeTabOrderKeepingHidden(displaySparks, orderedIds, hiddenWorkerIds);
      setOrderOverride(next);
      try {
        await reorderSparks(next);
      } catch (err) {
        console.error("Failed to reorder Sparks:", err);
        setOrderOverride(null);
        setActionError(
          `Could not save the Spark order: ${err instanceof Error ? err.message : String(err)}. The previous order was restored.`
        );
      }
    },
    [displaySparks, hiddenWorkerIds]
  );

  const [showPalette, setShowPalette] = useState(false);

  // Deep components (e.g. the LLM panel's "Tool Eval" button) navigate without prop drilling.
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<string | { id: string; spark?: string }>).detail;
      const id = typeof detail === "string" ? detail : detail?.id;
      const spark = typeof detail === "object" ? detail?.spark : undefined;
      if (spark) {
        try {
          localStorage.setItem(BENCH_SPARK_KEY, spark);
        } catch {
          /* private mode */
        }
      }
      if (typeof id === "string" && id) navigate(id);
    };
    window.addEventListener("sparkdash:navigate", onNav);
    return () => window.removeEventListener("sparkdash:navigate", onNav);
  }, [navigate]);

  // Ctrl/⌘ K opens the palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        // Not while typing in a field, where Ctrl+B may mean something else.
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = [
      { id: "nav:overview", group: "Go to", label: "Overview", hint: "Fleet", icon: <GridIcon className="h-4 w-4" />, keywords: "home fleet", run: () => navigate(OVERVIEW_ID) },
    ];
    cmds.push(
      { id: "nav:tokens", group: "Go to", label: "Token totals", hint: "Page", icon: <TokensIcon className="h-4 w-4" />, keywords: "llm tokens generated prompt cached usage", run: () => navigate(TOKENS_ID) },
      { id: "nav:energy", group: "Go to", label: "Fleet energy", hint: "Page", icon: <BoltIcon className="h-4 w-4" />, keywords: "power kwh watts cost electricity", run: () => navigate(ENERGY_ID) },
      { id: "nav:activity", group: "Go to", label: "Activity", hint: "Page", icon: <ListIcon className="h-4 w-4" />, keywords: "events log history recent", run: () => navigate(ACTIVITY_ID) }
    );
    for (const s of displaySparks) {
      cmds.push({
        id: `nav:${s.id}`,
        group: "Go to",
        label: s.name,
        hint: s.online ? "online" : "offline",
        icon: <ServerIcon className="h-4 w-4" />,
        keywords: `spark ${s.id}`,
        run: () => navigate(s.id),
      });
    }
    for (const b of BENCH_TYPES) {
      cmds.push({
        id: `bench:${b.id}`,
        group: "Benchmarks",
        label: `${b.label} benchmark`,
        hint: b.family,
        icon: <BenchIcon id={b.id} className="h-4 w-4" />,
        keywords: `bench benchmark ${b.blurb}`,
        run: () => navigate(benchId(b.id)),
      });
    }
    cmds.push({ id: "act:add", group: "Actions", label: "Add a Spark or GPU host", icon: <PlusIcon className="h-4 w-4" />, keywords: "new register connect", run: () => setShowAdd(true) });
    const sc = showcaseTarget(displaySparks);
    if (sc) {
      cmds.push({ id: "act:showcase", group: "Actions", label: `Open prompt showcase on ${sc.name}`, icon: <TerminalIcon className="h-4 w-4" />, keywords: "demo streams terminals", run: () => openShowcase(sc) });
    }
    if (displayActive) {
      cmds.push({ id: "act:edit", group: "Actions", label: `Edit ${displayActive.name}`, icon: <EditIcon className="h-4 w-4" />, keywords: "settings role ports", run: () => setEditId(displayActive.id) });
    }
    cmds.push(
      { id: "act:theme", group: "Actions", label: "Switch theme", hint: "white · light · dark · oled", icon: <SunIcon className="h-4 w-4" />, keywords: "appearance dark light", run: () => window.dispatchEvent(new Event("sparkdash:cycle-theme")) },
      { id: "act:sidebar", group: "Actions", label: "Show or hide the sidebar", icon: <PanelLeftIcon className="h-4 w-4" />, keywords: "collapse expand navigation rail menu", run: toggleSidebar },
      { id: "act:settings", group: "Actions", label: "Open settings", icon: <GearIcon className="h-4 w-4" />, keywords: "preferences density refresh", run: () => setShowSettings(true) }
    );
    return cmds;
  }, [displaySparks, displayActive, navigate, toggleSidebar]);

  return (
    <div className="min-h-screen text-text">
      <div className={`app-shell${sideHidden ? " app-shell--side-hidden" : ""}`}>
        <AppSidebar
          onCollapse={toggleSidebar}
          sparks={tabSparks}
          activeId={displayActive?.id ?? activeId}
          onSelect={navigate}
          onAdd={() => setShowAdd(true)}
          onEdit={(id) => setEditId(id)}
          onReorder={handleReorder}
          onOpenSettings={() => setShowSettings(true)}
          onOpenSearch={() => setShowPalette(true)}
          benchType={benchType}
          onSelectBench={(type) => navigate(benchId(type))}
          connected={connected}
          refreshInterval={refreshInterval}
        />
        {sideHidden ? (
          <div className="side-strip">
            <button type="button" className="icon-circle" onClick={toggleSidebar} title="Show sidebar (Ctrl+B)" aria-label="Show sidebar">
              <PanelLeftIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <div className="app-main">
          {/* Phone-only bar: on larger screens search and theme live in the sidebar. */}
          <header className="app-topbar">
            <button type="button" className="brand" onClick={() => navigate(OVERVIEW_ID)} aria-label="sparkDash overview">
              <span className="brand__mark">
                <BoltIcon className="h-[17px] w-[17px]" />
              </span>
              <span>
                spark<span className="brand__dash">Dash</span>
              </span>
            </button>
            <button type="button" className="search-trigger" onClick={() => setShowPalette(true)} aria-label="Open command palette">
              <SearchIcon className="h-4 w-4" />
            </button>
            <ThemeSwitch />
          </header>
          <div className="app-content">
            <ConnectionBanner
              connected={connected}
              lastValidSnapshotAt={lastValidSnapshotAt}
              snapshotError={snapshotError}
              now={telemetryNow}
              stale={telemetryStale}
            />
            <ErrorBanner message={actionError} onDismiss={() => setActionError(null)} />
            <main className={telemetryStale || !connected ? "telemetry-stale" : undefined}>
              {activeId === TOKENS_ID ? (
                <TokensPage sparks={displaySparks} onSelectSpark={navigate} />
              ) : activeId === ENERGY_ID ? (
                <EnergyPage sparks={displaySparks} settings={settings} onSelectSpark={navigate} />
              ) : activeId === ACTIVITY_ID ? (
                <ActivityPage sparks={displaySparks} onSelectSpark={navigate} />
              ) : benchType ? (
                <BenchPage type={benchType} sparks={displaySparks} benchShareImage={settings?.benchShareImage ?? false} />
              ) : isOverview ? (
                <OverviewPage
                  sparks={displaySparks}
                  hideOffline={settings?.autoHideOffline ?? false}
                  hideWorkers={hideWorkers}
                  showFleetEnergy={settings?.showFleetEnergy ?? true}
                  showFleetExceptions={settings?.showFleetExceptions ?? false}
                  showOverviewSearch={settings?.showOverviewSearch ?? false}
                  showLlmTokenTotals={settings?.showLlmTokenTotals ?? true}
                  temperatureUnit={settings?.temperatureUnit ?? "celsius"}
                  onSelectSpark={navigate}
                  onNavigate={navigate}
                />
              ) : displayActive ? (
                <SparkPage
                  spark={displayActive}
                  temperatureUnit={settings?.temperatureUnit ?? "celsius"}
                  benchShareImage={settings?.benchShareImage ?? false}
                  onEdit={() => setEditId(displayActive.id)}
                />
              ) : (
                <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
                  <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
                    <PlusIcon className="h-5 w-5" />
                  </div>
                  <h2 className="text-sm font-semibold text-text-strong">No Spark registered</h2>
                  <p className="mt-1 text-xs text-muted">Add a DGX Spark or GPU host to start monitoring.</p>
                  <button type="button" className="btn btn--primary mt-4" onClick={() => setShowAdd(true)}>
                    <PlusIcon className="h-3.5 w-3.5" />
                    Add Spark
                  </button>
                </div>
              )}
            </main>
          </div>
        </div>
      </div>
      <MobileTabBar
        sparks={tabSparks}
        activeId={displayActive?.id ?? activeId}
        onSelect={navigate}
        onAdd={() => setShowAdd(true)}
        onOpenSearch={() => setShowPalette(true)}
        onOpenSettings={() => setShowSettings(true)}
      />
      <CommandPalette open={showPalette} onClose={() => setShowPalette(false)} commands={paletteCommands} />
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
