import { useState, useEffect, useCallback } from "react";
import type { SparkSnapshot } from "../../api/types";
import { updateSpark, refreshSparkMetric, addLlmPort, removeLlmPort } from "../../api/client";
import { SparkHeader } from "./SparkHeader";
import { GpuPanel } from "./GpuPanel";
import { CpuPanel } from "./CpuPanel";
import { StoragePanel } from "./StoragePanel";
import { NetworkPanel } from "./NetworkPanel";
import { LlmPanel } from "./LlmPanel";

interface SparkPageProps {
  spark: SparkSnapshot;
  temperatureUnit: "celsius" | "fahrenheit";
  onEdit?: () => void;
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

  return (
    <div className="space-y-[18px]">
      <SparkHeader spark={spark} onEdit={onEdit} />
      <div className="spark-page grid gap-[18px] md:grid-cols-2">
        <GpuPanel gpu={metrics.gpu} temperatureUnit={temperatureUnit} />
        <CpuPanel cpu={metrics.cpu} ram={metrics.ram} unifiedMemory={metrics.unifiedMemory} />
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
        {!spark.workerNode && (
          <>
            {llmPorts.map((port, i) => {
              const llmMetrics = metrics.llm?.[i] ?? null;
              return (
                <LlmPanel
                  key={port}
                  llm={llmMetrics}
                  sparkId={spark.id}
                  llmPort={port}
                  llmPortsCount={llmPorts.length}
                  onRemovePort={llmPorts.length > 1 ? handleRemovePort : undefined}
                  className="md:col-span-2"
                />
              );
            })}
            {showAddPort ? (
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
            )}
          </>
        )}
      </div>
    </div>
  );
}