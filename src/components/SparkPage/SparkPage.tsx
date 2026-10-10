import { useState, useEffect, useCallback, type CSSProperties, type ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { isLlmMonitoringEnabled } from "../../api/sparkRole";
import { updateSpark, refreshSparkMetric, addLlmPort, removeLlmPort } from "../../api/client";
import { SparkHeader } from "./SparkHeader";
import { HealthList } from "../ui/HealthFindings";
import { SparkActions } from "./SparkActions";
import { GpuPanel } from "./GpuPanel";
import { CpuPanel } from "./CpuPanel";
import { RamPanel } from "./RamPanel";
import { StoragePanel } from "./StoragePanel";
import { NetworkPanel } from "./NetworkPanel";
import { TailscalePanel } from "./TailscalePanel";
import { LlmPanel } from "./LlmPanel";
import { ComfyPanel } from "./ComfyPanel";
import { LlmModelsPanel } from "./LlmModelsPanel";
import { UnifiedMemoryPanel } from "./UnifiedMemoryPanel";
import "../../styles/spark.css";
import { vramContextFor } from "../../shared/vramBreakdown";

interface SparkPageProps {
  spark: SparkSnapshot;
  /** Every unit's snapshot — lets a worker find its head's LLM endpoint. */
  fleet?: SparkSnapshot[];
  temperatureUnit: "celsius" | "fahrenheit";
  /** Show "Copy image" in the benchmark dialogs (Settings, off by default). */
  benchShareImage?: boolean;
  /** GPU panel VRAM bar split by engine / system / free (Settings, on by default). */
  showVramBreakdown?: boolean;
  onEdit?: () => void;
}

type SparkView = "all" | "resources" | "services";

/** Panel wrapper carrying its single-column (mobile) order as a CSS variable. */
function Item({ order, children }: { order: number; children: ReactNode }) {
  return (
    <div className="sp-item" style={{ ["--o" as string]: order } as CSSProperties}>
      {children}
    </div>
  );
}

export function SparkPage({
  spark,
  fleet,
  temperatureUnit,
  benchShareImage = false,
  showVramBreakdown = true,
  onEdit,
}: SparkPageProps) {
  const { metrics } = spark;
  const [disabledDevices, setDisabledDevices] = useState<string[]>(spark.disabledDevices || []);
  const [disabledInterfaces, setDisabledInterfaces] = useState<string[]>(
    spark.disabledInterfaces || []
  );
  const [llmPorts, setLlmPorts] = useState<number[]>(spark.llmPorts ?? [spark.llmPort ?? 8888]);
  const [storagePollDisabled, setStoragePollDisabled] = useState<boolean>(
    spark.storagePollDisabled ?? false
  );
  const [showAddPort, setShowAddPort] = useState(false);
  const [newPortDraft, setNewPortDraft] = useState("");
  // Sync when spark data changes (WS push)
  useEffect(() => {
    setDisabledDevices(spark.disabledDevices || []);
  }, [spark.disabledDevices]);

  useEffect(() => {
    setDisabledInterfaces(spark.disabledInterfaces || []);
  }, [spark.disabledInterfaces]);

  useEffect(() => {
    if (spark.llmPorts) setLlmPorts(spark.llmPorts);
  }, [spark.llmPorts]);

  useEffect(() => {
    setStoragePollDisabled(spark.storagePollDisabled ?? false);
  }, [spark.storagePollDisabled]);

  const handleStoragePollModeChange = useCallback(
    async (disabled: boolean) => {
      setStoragePollDisabled(disabled);
      try {
        await updateSpark(spark.id, { storagePollDisabled: disabled });
        // When disabling auto-refresh, do one manual refresh immediately
        if (disabled) {
          refreshSparkMetric(spark.id, "storage").catch((err) =>
            console.error("Failed to refresh storage after disabling auto-refresh:", err)
          );
        }
      } catch (err) {
        console.error("Failed to update storage poll mode:", err);
        setStoragePollDisabled(!disabled); // revert
      }
    },
    [spark.id]
  );

  const handleAddPort = useCallback(async () => {
    const port = parseInt(newPortDraft, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    if (llmPorts.includes(port)) {
      setNewPortDraft("");
      setShowAddPort(false);
      return;
    }
    try {
      const result = await addLlmPort(spark.id, port);
      setLlmPorts(result.llmPorts);
      setNewPortDraft("");
      setShowAddPort(false);
    } catch (err) {
      console.error("Failed to add LLM port:", err);
    }
  }, [spark.id, newPortDraft, llmPorts]);

  const handleRemovePort = useCallback(async (port: number) => {
    try {
      const result = await removeLlmPort(spark.id, port);
      setLlmPorts(result.llmPorts);
    } catch (err) {
      console.error("Failed to remove LLM port:", err);
    }
  }, [spark.id]);

  const llmOn = isLlmMonitoringEnabled(spark);
  const comfyOn = Boolean(spark.comfyMonitoring);
  const tailscaleOn = Boolean(spark.tailscaleMonitoring);
  const showServices = llmOn || comfyOn;
  // Everything on one page: hardware and services together (no sub-tabs).
  const view: SparkView = showServices ? "all" : "resources";
  const showSvc = showServices && view !== "resources";
  // Models you start/stop with your own start.sh / stop.sh. Shown on every Spark and in every tab,
  // so it is always easy to find (a worker may have its own scripts too).
  const modelsPanel = <LlmModelsPanel spark={spark} />;
  const primaryPort = llmPorts[0];
  const extraPorts = llmPorts.slice(1);
  const unified = metrics.unifiedMemory;
  const showUnified = spark.kind !== "host" && unified != null && unified.total > 0;

  const renderLlmPanel = (port: number, portIndex: number, className?: string) => {
    const llmMetrics = metrics.llm?.[portIndex] ?? null;
    const canRemove = portIndex > 0;
    return (
      <LlmPanel
        key={port}
        llm={llmMetrics}
        sparkId={spark.id}
        sparkName={spark.name}
        llmPort={port}
        llmPorts={llmPorts}
        hasApiKey={Boolean(spark.llmApiKeyPorts?.includes(port))}
        shareImage={benchShareImage}
        onRemovePort={canRemove ? handleRemovePort : undefined}
        className={className}
      />
    );
  };

  const addPort = llmOn ? (
    showAddPort ? (
      <div className="panel sp-add-port">
        <input
          type="number"
          min={1}
          max={65535}
          inputMode="numeric"
          placeholder="Port number"
          value={newPortDraft}
          onChange={(e) => setNewPortDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleAddPort();
            }
          }}
          className="sp-input sp-input--port"
          autoFocus
        />
        <button
          type="button"
          onClick={() => void handleAddPort()}
          disabled={!newPortDraft.trim()}
          className="btn btn--sm btn--primary"
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => {
            setShowAddPort(false);
            setNewPortDraft("");
          }}
          className="btn btn--sm"
        >
          Cancel
        </button>
      </div>
    ) : (
      <button type="button" onClick={() => setShowAddPort(true)} className="sp-add-port-btn">
        + Add LLM port
      </button>
    )
  ) : null;

  const comfyPanel = comfyOn ? (
    <ComfyPanel
      comfy={metrics.comfy ?? null}
      comfyPort={spark.comfyPort ?? 8188}
      sparkId={spark.id}
      lanIp={spark.lanIp}
    />
  ) : null;

  return (
    <div className="sp">
      <SparkHeader spark={spark} onEdit={onEdit} />
      {/* Mobile-only action row (Update Hermes / Edit / Power) — desktop keeps them in the header. */}
      <SparkActions spark={spark} onEdit={onEdit} className="sp-mobile-actions flex sm:hidden" />
      {spark.online ? <HealthList findings={spark.health} /> : null}

      {(
        /* Two independent columns (xl+): hardware on the left, services + I/O on the
           right. Below xl everything stacks in the Item order (GPU, memory, LLM first). */
        <div className="sp-cols">
          <div className="sp-col">
            <Item order={1}>
              <GpuPanel
                gpu={metrics.gpu}
                vramContext={showVramBreakdown ? vramContextFor(spark, fleet) : null}
                sparkId={spark.id}
                temperatureUnit={temperatureUnit}
                chip={spark.hardware.gpuChip}
                hideMemory={showUnified}
              />
            </Item>
            {/* Unified memory (or RAM on a dedicated host) and CPU sit side by side (they stack when the column is narrow). */}
            <Item order={2}>
              <div className="sp-pair">
                {showUnified && <UnifiedMemoryPanel um={unified} gpu={metrics.gpu} llm={metrics.llm} />}
                <CpuPanel
                  cpu={metrics.cpu}
                  hardware={spark.hardware}
                  sparkId={spark.id}
                  temperatureUnit={temperatureUnit}
                />
                {/* Dedicated hosts have system RAM instead of a unified pool: CPU and RAM side by side. */}
                {spark.kind === "host" && <RamPanel ram={metrics.ram} sparkId={spark.id} />}
              </div>
            </Item>
            {spark.platform !== "windows" && <Item order={4}>{modelsPanel}</Item>}
          </div>
          <div className="sp-col">
            {view === "all" && showSvc && llmOn && primaryPort != null && (
              <Item order={3}>{renderLlmPanel(primaryPort, 0)}</Item>
            )}
            {view === "all" && showSvc && comfyPanel && <Item order={4}>{comfyPanel}</Item>}
            {view === "all" &&
              showSvc &&
              llmOn &&
              extraPorts.map((port, j) => (
                <Item key={port} order={10 + j}>
                  {renderLlmPanel(port, j + 1)}
                </Item>
              ))}
            {view === "all" && showSvc && addPort && <Item order={30}>{addPort}</Item>}
            <Item order={7}>
              <StoragePanel
                storage={metrics.storage}
                sparkId={spark.id}
                disabledDevices={disabledDevices}
                onDisabledChange={setDisabledDevices}
                storagePollDisabled={storagePollDisabled}
                onStoragePollModeChange={handleStoragePollModeChange}
              />
            </Item>
            <Item order={8}>
              <NetworkPanel
                network={metrics.network}
                sparkId={spark.id}
                disabledInterfaces={disabledInterfaces}
                onDisabledChange={setDisabledInterfaces}
              />
            </Item>
            {tailscaleOn && (
              <Item order={9}>
                <TailscalePanel tailscale={metrics.tailscale ?? null} />
              </Item>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
