import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  checkOccupancyHelper,
  deleteOccupancyHelper,
  fetchOccupancyHelpers,
  saveOccupancyHelpers,
} from "../api/client";
import type { OccupancyCheck, OccupancyHelper, OccupancyHelperInput, OccupancyRoute } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import { XIcon } from "./ui/icons";

const HARNESSES = [
  { id: "openclaw", label: "OpenClaw" },
  { id: "opencode", label: "OpenCode" },
  { id: "omp", label: "oh-my-pi" },
  { id: "hermes", label: "Hermes" },
  { id: "dsh", label: "DeepSeek Harness" },
] as const;

export interface HarnessSparkOption {
  id: string;
  name: string;
  llmPorts: number[];
}

interface HarnessWizardProps {
  open: boolean;
  onClose: () => void;
  sparks: HarnessSparkOption[];
  sparkId?: string;
}

interface RouteDraft {
  harness: string;
  sparkId: string;
  port: string;
  cwdPrefix: string;
}

interface Draft {
  id?: string;
  label: string;
  url: string;
  token: string;
  clearToken: boolean;
  enabled: boolean;
  harnesses: string[];
  routes: RouteDraft[];
}

const STEPS = ["Harnesses", "Connection", "Routes", "Check", "Review"] as const;

function emptyDraft(): Draft {
  return {
    label: "",
    url: "http://127.0.0.1:8790/occupancy",
    token: "",
    clearToken: false,
    enabled: true,
    harnesses: [],
    routes: [],
  };
}

function draftFromHelper(helper: OccupancyHelper): Draft {
  return {
    id: helper.id,
    label: helper.label,
    url: helper.url,
    token: "",
    clearToken: false,
    enabled: helper.enabled,
    harnesses: [...helper.harnesses],
    routes: helper.routes.map((route) => ({
      harness: route.harness,
      sparkId: route.sparkId,
      port: String(route.port),
      cwdPrefix: route.cwdPrefix || "",
    })),
  };
}

function preferredSpark(sparks: HarnessSparkOption[], sparkId?: string) {
  return sparks.find((spark) => spark.id === sparkId) || sparks[0];
}

function withRoutes(draft: Draft, sparks: HarnessSparkOption[], sparkId?: string): Draft {
  const spark = preferredSpark(sparks, sparkId);
  const routes = draft.routes.filter((route) => draft.harnesses.includes(route.harness));
  for (const harness of draft.harnesses) {
    if (routes.some((route) => route.harness === harness)) continue;
    routes.push({
      harness,
      sparkId: spark?.id || "",
      port: spark?.llmPorts?.[0] ? String(spark.llmPorts[0]) : "",
      cwdPrefix: "",
    });
  }
  return { ...draft, routes };
}

function parseUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Use an http or https URL";
    if (parsed.username || parsed.password) return "Remove the username and password from the URL";
    if (!parsed.hostname) return "The URL needs a host";
    return null;
  } catch {
    return "Enter a helper URL";
  }
}

function snippetFor(harnesses: string[]): string {
  const lines = [
    "OCCUPANCY_BIND=127.0.0.1",
    'OCCUPANCY_TOKEN="$(openssl rand -hex 32)"',
    `OCCUPANCY_ADAPTERS=${harnesses.join(",")}`,
  ];
  if (harnesses.includes("hermes")) lines.push("HERMES_STATE_DIR=$HOME/.hermes");
  if (harnesses.includes("dsh")) lines.push("DSH_WEB_URL=http://127.0.0.1:3080");
  lines.push("node scripts/occupancy-helper/index.js");
  return lines.join(" \\\n");
}

function toInput(helper: OccupancyHelper): OccupancyHelperInput {
  return {
    id: helper.id,
    label: helper.label,
    url: helper.url,
    enabled: helper.enabled,
    harnesses: helper.harnesses,
    routes: helper.routes,
  };
}

function routesFromDraft(routes: RouteDraft[]): OccupancyRoute[] {
  return routes
    .filter((route) => route.sparkId && route.port)
    .map((route) => ({
      harness: route.harness,
      sparkId: route.sparkId,
      port: Number(route.port),
      ...(route.cwdPrefix.trim() ? { cwdPrefix: route.cwdPrefix.trim() } : {}),
    }));
}

export function HarnessWizard({ open, onClose, sparks, sparkId }: HarnessWizardProps) {
  const { mounted, visible } = useModalPresence(open);
  const [helpers, setHelpers] = useState<OccupancyHelper[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [check, setCheck] = useState<OccupancyCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchOccupancyHelpers()
      .then((data) => {
        const list = data.helpers || [];
        setHelpers(list);
        if (list.length === 0) {
          setDraft(emptyDraft());
          setEditing(true);
          setStep(0);
        } else {
          setEditing(false);
        }
      })
      .catch((err: Error) => setError(err.message || "Could not load helpers"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    setCheck(null);
    setStep(0);
    load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const sparkName = useMemo(() => new Map(sparks.map((spark) => [spark.id, spark.name])), [sparks]);

  const toggleHarness = (id: string) => {
    setDraft((prev) => {
      const harnesses = prev.harnesses.includes(id)
        ? prev.harnesses.filter((item) => item !== id)
        : [...prev.harnesses, id];
      return { ...prev, harnesses };
    });
  };

  const goNext = () => {
    if (step === 0 && draft.harnesses.length === 0) {
      setError("Pick at least one harness");
      return;
    }
    if (step === 1) {
      const problem = parseUrl(draft.url);
      if (problem) {
        setError(problem);
        return;
      }
    }
    if (step === 2) {
      const bad = draft.routes.find((route) => route.sparkId && (!Number.isInteger(Number(route.port)) || Number(route.port) < 1 || Number(route.port) > 65535));
      if (bad) {
        setError("Each route needs a port from 1 to 65535");
        return;
      }
    }
    setError(null);
    if (step === 1) setDraft((prev) => withRoutes(prev, sparks, sparkId));
    setStep((prev) => Math.min(prev + 1, STEPS.length - 1));
  };

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await checkOccupancyHelper(draft.url, draft.token);
      setCheck(result);
    } catch (err: unknown) {
      setCheck(null);
      setError(err instanceof Error ? err.message : "Check failed");
    } finally {
      setChecking(false);
    }
  };

  const save = async (nextHelpers: OccupancyHelperInput[]) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveOccupancyHelpers(nextHelpers);
      setHelpers(saved.helpers);
      setEditing(false);
      setStep(0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = () => {
    const others = helpers.filter((helper) => helper.id !== draft.id).map(toInput);
    const body: OccupancyHelperInput = {
      ...(draft.id ? { id: draft.id } : {}),
      label: draft.label,
      url: draft.url.trim(),
      enabled: draft.enabled,
      harnesses: draft.harnesses,
      routes: routesFromDraft(draft.routes),
    };
    if (draft.token) body.token = draft.token;
    else if (draft.clearToken) body.token = "";
    return save([...others, body]);
  };

  const setEnabled = (helper: OccupancyHelper, enabled: boolean) => {
    const next = helpers.map((item) => (item.id === helper.id ? { ...toInput(item), enabled } : toInput(item)));
    return save(next);
  };

  const remove = async (helper: OccupancyHelper) => {
    if (!window.confirm(`Remove helper ${helper.label || helper.id}?`)) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await deleteOccupancyHelper(helper.id);
      setHelpers(saved.helpers);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-sheet modal-sheet--wide" role="dialog" aria-modal="true" aria-labelledby="harness-title">
        <div className="modal-sheet__header">
          <h2 className="modal-sheet__title" id="harness-title">Harness sessions</h2>
          <button type="button" className="modal-sheet__close" onClick={onClose} aria-label="Close">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="modal-sheet__body">
          {loading && <p className="bench-sheet__hint">Loading…</p>}
          {error && <p role="alert" className="modal-sheet__error">{error}</p>}
          {!loading && !editing && (
            <div className="harness-list">
              {helpers.map((helper) => (
                <article key={helper.id}>
                  <div>
                    <strong>{helper.label || helper.id}</strong>
                    <div className="occupancy-ctx">{helper.enabled ? helper.harnesses.join(", ") : "Disabled"}</div>
                  </div>
                  <button type="button" className="btn btn--sm" onClick={() => { setDraft(draftFromHelper(helper)); setEditing(true); setStep(0); setCheck(null); setError(null); }}>Edit</button>
                  <button type="button" className="btn btn--sm" onClick={() => void setEnabled(helper, !helper.enabled)} disabled={saving}>
                    {helper.enabled ? "Disable" : "Enable"}
                  </button>
                  <button type="button" className="btn btn--sm" onClick={() => void remove(helper)} disabled={saving}>Remove</button>
                </article>
              ))}
              <button type="button" className="btn btn--primary" onClick={() => { setDraft(emptyDraft()); setEditing(true); setStep(0); setCheck(null); setError(null); }}>
                Add helper
              </button>
            </div>
          )}
          {!loading && editing && (
            <>
              <p className="bench-sheet__hint">Step {step + 1} of {STEPS.length}: {STEPS[step]}</p>
              {step === 0 && (
                <div className="harness-pick" role="group" aria-label="Harnesses">
                  {HARNESSES.map((harness) => (
                    <label key={harness.id}>
                      <input
                        type="checkbox"
                        aria-label={harness.label}
                        checked={draft.harnesses.includes(harness.id)}
                        onChange={() => toggleHarness(harness.id)}
                      />
                      {harness.label}
                    </label>
                  ))}
                </div>
              )}
              {step === 1 && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    goNext();
                  }}
                >
                  <label className="harness-field">
                    <span>Name</span>
                    <input aria-label="Helper name" name="helper-name" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
                  </label>
                  <label className="harness-field">
                    <span>Helper URL</span>
                    <input aria-label="Helper URL" name="helper-url" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
                  </label>
                  <label className="harness-field">
                    <span>{draft.id ? "New bearer token (leave blank to keep the saved one)" : "Bearer token"}</span>
                    <input aria-label="Bearer token" name="helper-token" type="password" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value, clearToken: false })} autoComplete="off" />
                  </label>
                  {draft.id && (
                    <label>
                      <input type="checkbox" aria-label="Clear saved token" checked={draft.clearToken} onChange={(event) => setDraft({ ...draft, clearToken: event.target.checked, token: "" })} />
                      Clear saved token
                    </label>
                  )}
                </form>
              )}
              {step === 2 && (
                <div className="harness-routes">
                  <p className="bench-sheet__hint">A route sends one harness to a Spark and port. A directory prefix wins over a general route. Rows with no route stay off the cards.</p>
                  {draft.routes.map((route, index) => (
                    <div key={`${route.harness}-${index}`}>
                      <strong>{HARNESSES.find((item) => item.id === route.harness)?.label || route.harness}</strong>
                      <div className="harness-route">
                        <select
                          aria-label={`Spark for ${route.harness}`}
                          value={route.sparkId}
                          onChange={(event) => {
                            const spark = sparks.find((item) => item.id === event.target.value);
                            setDraft((prev) => {
                              const routes = [...prev.routes];
                              routes[index] = {
                                ...routes[index],
                                sparkId: event.target.value,
                                port: spark?.llmPorts?.[0] ? String(spark.llmPorts[0]) : routes[index].port,
                              };
                              return { ...prev, routes };
                            });
                          }}
                        >
                          <option value="">Unassigned</option>
                          {sparks.map((spark) => (
                            <option key={spark.id} value={spark.id}>{spark.name}</option>
                          ))}
                        </select>
                        <input
                          aria-label={`Port for ${route.harness}`}
                          inputMode="numeric"
                          value={route.port}
                          onChange={(event) => {
                            const port = event.target.value;
                            setDraft((prev) => {
                              const routes = [...prev.routes];
                              routes[index] = { ...routes[index], port };
                              return { ...prev, routes };
                            });
                          }}
                        />
                      </div>
                      <label className="harness-field">
                        <span>Directory prefix, optional</span>
                        <input
                          aria-label={`Directory prefix for ${route.harness}`}
                          value={route.cwdPrefix}
                          onChange={(event) => {
                            const cwdPrefix = event.target.value;
                            setDraft((prev) => {
                              const routes = [...prev.routes];
                              routes[index] = { ...routes[index], cwdPrefix };
                              return { ...prev, routes };
                            });
                          }}
                        />
                      </label>
                    </div>
                  ))}
                </div>
              )}
              {step === 3 && (
                <div>
                  <button type="button" className="btn btn--primary" onClick={() => void runCheck()} disabled={checking}>
                    {checking ? "Checking…" : "Check connection"}
                  </button>
                  {check && (
                    <>
                      <p>{check.rowCount} sessions</p>
                      <ul className="harness-check-list">
                        {Object.entries(check.adapters).map(([id, adapter]) => (
                          <li key={id}>{id}: {adapter.coverage}{adapter.stale ? ", stale" : ""}{adapter.error ? ` (${adapter.error})` : ""}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
              {step === 4 && (
                <div>
                  <p>{draft.harnesses.join(", ")} via {draft.url}</p>
                  <ul className="harness-check-list">
                    {draft.routes.filter((route) => route.sparkId).map((route) => (
                      <li key={`${route.harness}-${route.sparkId}-${route.port}`}>
                        {route.harness} → {sparkName.get(route.sparkId) || route.sparkId}:{route.port}
                        {route.cwdPrefix ? ` ${route.cwdPrefix}` : ""}
                      </li>
                    ))}
                  </ul>
                  <pre className="harness-snippet">{snippetFor(draft.harnesses)}</pre>
                </div>
              )}
            </>
          )}
        </div>
        {editing && (
          <div className="modal-sheet__footer">
            <div className="modal-sheet__footer-actions">
              <button type="button" className="btn btn--ghost" onClick={() => (step === 0 ? setEditing(helpers.length > 0) : setStep((prev) => prev - 1))}>
                {step === 0 ? "Back" : "Back"}
              </button>
              {step < STEPS.length - 1 ? (
                <button type="button" className="btn btn--primary" onClick={goNext}>Next</button>
              ) : (
                <button type="button" className="btn btn--primary" onClick={() => void saveDraft()} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
