import { useState, useEffect, useCallback, useMemo, type CSSProperties } from "react";
import type { ConversationRow, SparkSnapshot } from "../../api/types";
import { isLlmMonitoringEnabled } from "../../api/sparkRole";
import { updateSpark, refreshSparkMetric, addLlmPort, removeLlmPort } from "../../api/client";
import { SparkHeader } from "./SparkHeader";
import { SparkActions } from "./SparkActions";
import { GpuPanel } from "./GpuPanel";
import { RamPanel } from "./RamPanel";
import { StoragePanel } from "./StoragePanel";
import { NetworkPanel } from "./NetworkPanel";
import { TailscalePanel } from "./TailscalePanel";
import { LlmPanel } from "./LlmPanel";
import { ComfyPanel } from "./ComfyPanel";
import { ChevronDownIcon } from "../ui/icons";

interface SparkPageProps {
  spark: SparkSnapshot;
  temperatureUnit: "celsius" | "fahrenheit";
  onEdit?: () => void;
}

const EMPTY_CONVERSATIONS: ConversationRow[] = [];

const SECTION_OPEN_KEYS = {
  resources: "sparkdash.ui.section.resources",
  services: "sparkdash.ui.section.services",
} as const;

function readSectionOpen(key: string, fallback = true): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "0" || raw === "false") return false;
    if (raw === "1" || raw === "true") return true;
  } catch {
    /* private mode / blocked storage */
  }
  return fallback;
}

function writeSectionOpen(key: string, open: boolean) {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Clickable section title with chevron; collapses/expands the panels below. */
function SectionHeading({
  title,
  open,
  onToggle,
  style,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="md:col-span-2 flex w-full items-center gap-2 text-left font-normal leading-tight tracking-tight text-text-strong transition-colors hover:text-accent"
      style={{
        fontSize: "var(--density-overview-title)",
        ...style,
      }}
    >
      <ChevronDownIcon
        className={`h-5 w-5 shrink-0 text-muted transition-transform duration-150 ${
          open ? "" : "-rotate-90"
        }`}
      />
      <span>{title}</span>
    </button>
  );
}

export function SparkPage({ spark, temperatureUnit, onEdit }: SparkPageProps) {
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
  const [resourcesOpen, setResourcesOpen] = useState(() =>
    readSectionOpen(SECTION_OPEN_KEYS.resources, true)
  );
  const [servicesOpen, setServicesOpen] = useState(() =>
    readSectionOpen(SECTION_OPEN_KEYS.services, true)
  );

  const toggleResources = useCallback(() => {
    setResourcesOpen((prev) => {
      const next = !prev;
      writeSectionOpen(SECTION_OPEN_KEYS.resources, next);
      return next;
    });
  }, []);

  const toggleServices = useCallback(() => {
    setServicesOpen((prev) => {
      const next = !prev;
      writeSectionOpen(SECTION_OPEN_KEYS.services, next);
      return next;
    });
  }, []);

  const conversationsByPort = useMemo(() => {
    const byPort = new Map<number, ConversationRow[]>();
    for (const row of spark.conversations ?? []) {
      const list = byPort.get(row.port);
      if (list) list.push(row);
      else byPort.set(row.port, [row]);
    }
    return byPort;
  }, [spark.conversations]);

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
  /** First LLM + Comfy share a row when both are on. */
  const primarySideBySide = llmOn && comfyOn;
  const showServices = llmOn || comfyOn;
  const primaryPort = llmPorts[0];
  const extraPorts = llmPorts.slice(1);

  /**
   * Extra LLM ports (after the primary):
   * - 1 extra → full-width own row
   * - 2+ extras → 2-column pairs; if odd count, last one full-width alone
   */
  const extraLlmFullWidth = (extraIndex: number, extraCount: number) => {
    if (extraCount === 1) return true;
    if (extraCount % 2 === 1 && extraIndex === extraCount - 1) return true;
    return false;
  };

  const renderLlmPanel = (port: number, portIndex: number, className?: string) => {
    const llmMetrics = metrics.llm?.[portIndex] ?? null;
    const canRemove = portIndex > 0;
    return (
      <LlmPanel
        key={port}
        llm={llmMetrics}
        sparkId={spark.id}
        llmPort={port}
        conversations={conversationsByPort.get(port) ?? EMPTY_CONVERSATIONS}
        llmPorts={llmPorts}
        hasApiKey={Boolean(spark.llmApiKeyPorts?.includes(port))}
        onRemovePort={canRemove ? handleRemovePort : undefined}
        className={className}
      />
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      <SparkHeader spark={spark} onEdit={onEdit} />
      {/* Mobile-only action row (Update Hermes / Shutdown·Wake / Edit) — desktop keeps them in the header. */}
      <SparkActions
        spark={spark}
        onEdit={onEdit}
        className="flex flex-wrap items-center justify-end gap-2 px-1 py-1 sm:hidden"
      />
      <div className="spark-page grid grid-cols-1 md:grid-cols-2" style={{ gap: "var(--density-page-gap)" }}>
        <SectionHeading
          title="Resources"
          open={resourcesOpen}
          onToggle={toggleResources}
          style={{ marginTop: "var(--density-page-gap)" }}
        />
        {resourcesOpen && (
          <>
            {spark.kind === "host" ? (
              /* Hosts: GPU spans the full left column; RAM → Network → Storage [→ Tailnet] stack in the right column */
              <>
                <GpuPanel
                  gpu={metrics.gpu}
                  sparkId={spark.id}
                  llmPort={primaryPort}
                  conversations={conversationsByPort.get(primaryPort) ?? EMPTY_CONVERSATIONS}
                  temperatureUnit={temperatureUnit}
                  className={tailscaleOn ? "md:row-span-4" : "md:row-span-3"}
                />
                <RamPanel
                  ram={metrics.ram}
                  cpu={metrics.cpu}
                  sparkId={spark.id}
                  temperatureUnit={temperatureUnit}
                />
                <NetworkPanel
                  network={metrics.network}
                  sparkId={spark.id}
                  disabledInterfaces={disabledInterfaces}
                  onDisabledChange={setDisabledInterfaces}
                />
                <StoragePanel
                  storage={metrics.storage}
                  sparkId={spark.id}
                  disabledDevices={disabledDevices}
                  onDisabledChange={setDisabledDevices}
                  storagePollDisabled={storagePollDisabled}
                  onStoragePollModeChange={handleStoragePollModeChange}
                />
                {tailscaleOn && <TailscalePanel tailscale={metrics.tailscale ?? null} />}
              </>
            ) : (
              /* Resources layout: GPU spans the full left column; Storage + Network [+ Tailnet] stack in the right column */
              <>
                <GpuPanel
                  gpu={metrics.gpu}
                  sparkId={spark.id}
                  temperatureUnit={temperatureUnit}
                  className={tailscaleOn ? "md:row-span-3" : "md:row-span-2"}
                />
                <StoragePanel
                  storage={metrics.storage}
                  sparkId={spark.id}
                  disabledDevices={disabledDevices}
                  onDisabledChange={setDisabledDevices}
                  storagePollDisabled={storagePollDisabled}
                  onStoragePollModeChange={handleStoragePollModeChange}
                />
                <NetworkPanel
                  network={metrics.network}
                  sparkId={spark.id}
                  disabledInterfaces={disabledInterfaces}
                  onDisabledChange={setDisabledInterfaces}
                />
                {tailscaleOn && <TailscalePanel tailscale={metrics.tailscale ?? null} />}
              </>
            )}
          </>
        )}
        {/*
          Services layout:
          - Primary LLM + ComfyUI → always same row, 2 columns (when both on)
          - Alone → full width
          - +1 LLM → own full-width row
          - +2 LLMs → 2-column row; odd leftover → full-width row
        */}
        {showServices && (
          <SectionHeading
            title="Services"
            open={servicesOpen}
            onToggle={toggleServices}
            style={{ marginTop: "var(--density-page-gap)" }}
          />
        )}
        {showServices && servicesOpen && (
          <>
            {llmOn &&
              primaryPort != null &&
              renderLlmPanel(
                primaryPort,
                0,
                primarySideBySide ? undefined : "md:col-span-2"
              )}
            {comfyOn && (
              <ComfyPanel
                comfy={metrics.comfy ?? null}
                comfyPort={spark.comfyPort ?? 8188}
                sparkId={spark.id}
                lanIp={spark.lanIp}
                className={primarySideBySide ? undefined : "md:col-span-2"}
              />
            )}
            {llmOn &&
              extraPorts.map((port, j) =>
                renderLlmPanel(
                  port,
                  j + 1,
                  extraLlmFullWidth(j, extraPorts.length) ? "md:col-span-2" : undefined
                )
              )}
            {llmOn &&
              (showAddPort ? (
                <div className="md:col-span-2 rounded-lg border border-border bg-surface p-3">
                  <div className="flex items-center gap-2">
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
                      className="w-32 rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-tabular text-sm text-text outline-none focus:border-accent"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => void handleAddPort()}
                      disabled={!newPortDraft.trim()}
                      className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddPort(false);
                        setNewPortDraft("");
                      }}
                      className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowAddPort(true)}
                  className="md:col-span-2 rounded-lg border border-dashed border-border bg-transparent p-3 text-xs text-muted hover:border-accent hover:text-accent transition-colors"
                >
                  + Add LLM port
                </button>
              ))}
          </>
        )}
      </div>
    </div>
  );
}