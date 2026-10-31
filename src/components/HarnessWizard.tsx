import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
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

function parseUrl(value: string): "invalidProtocol" | "credentials" | "missingHost" | "empty" | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "invalidProtocol";
    if (parsed.username || parsed.password) return "credentials";
    if (!parsed.hostname) return "missingHost";
    return null;
  } catch {
    return "empty";
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
  const { t } = useTranslation("devices");
  const steps = [t("harness.steps.harnesses"), t("harness.steps.connection"), t("harness.steps.routes"), t("harness.steps.check"), t("harness.steps.review")];
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
      .catch((err: Error) => setError(err.message || "load"))
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
      setError(t("harness.errors.pickHarness"));
      return;
    }
    if (step === 1) {
      const problem = parseUrl(draft.url);
      if (problem) {
        setError(problem === "invalidProtocol" ? t("harness.errors.invalidProtocol") : problem === "credentials" ? t("harness.errors.credentials") : problem === "missingHost" ? t("harness.errors.missingHost") : t("harness.errors.empty"));
        return;
      }
    }
    if (step === 2) {
      const bad = draft.routes.find((route) => route.sparkId && (!Number.isInteger(Number(route.port)) || Number(route.port) < 1 || Number(route.port) > 65535));
      if (bad) {
        setError(t("harness.errors.routePort"));
        return;
      }
    }
    setError(null);
    if (step === 1) setDraft((prev) => withRoutes(prev, sparks, sparkId));
    setStep((prev) => Math.min(prev + 1, steps.length - 1));
  };

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await checkOccupancyHelper(draft.url, draft.token);
      setCheck(result);
    } catch (err: unknown) {
      setCheck(null);
      setError(err instanceof Error ? err.message : "check");
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
      setError(err instanceof Error ? err.message : "save");
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
    if (!window.confirm(t("harness.removeConfirm", { name: helper.label || helper.id }))) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await deleteOccupancyHelper(helper.id);
      setHelpers(saved.helpers);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "remove");
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
          <h2 className="modal-sheet__title" id="harness-title">{t("harness.title")}</h2>
          <button type="button" className="modal-sheet__close" onClick={onClose} aria-label={t("actions.close")}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="modal-sheet__body">
          {loading && <p className="bench-sheet__hint">{t("actions.loading")}</p>}
          {error && <p role="alert" className="modal-sheet__error">{error === "load" ? t("harness.errors.load") : error === "check" ? t("harness.errors.check") : error === "save" ? t("harness.errors.save") : error === "remove" ? t("harness.errors.remove") : error}</p>}
          {!loading && !editing && (
            <div className="harness-list">
              {helpers.map((helper) => (
                <article key={helper.id}>
                  <div>
                    <strong>{helper.label || helper.id}</strong>
                    <div className="occupancy-ctx">{helper.enabled ? helper.harnesses.join(", ") : t("harness.disabled")}</div>
                  </div>
                  <button type="button" className="btn btn--sm" onClick={() => { setDraft(draftFromHelper(helper)); setEditing(true); setStep(0); setCheck(null); setError(null); }}>{t("actions.edit")}</button>
                  <button type="button" className="btn btn--sm" onClick={() => void setEnabled(helper, !helper.enabled)} disabled={saving}>
                    {helper.enabled ? t("actions.disable") : t("actions.enable")}
                  </button>
                  <button type="button" className="btn btn--sm" onClick={() => void remove(helper)} disabled={saving}>{t("actions.remove")}</button>
                </article>
              ))}
              <button type="button" className="btn btn--primary" onClick={() => { setDraft(emptyDraft()); setEditing(true); setStep(0); setCheck(null); setError(null); }}>
                {t("harness.addHelper")}
              </button>
            </div>
          )}
          {!loading && editing && (
            <>
              <p className="bench-sheet__hint">{t("harness.step", { current: step + 1, total: steps.length, name: steps[step] })}</p>
              {step === 0 && (
                <div className="harness-pick" role="group" aria-label={t("harness.harnesses")}>
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
                    <span>{t("harness.name")}</span>
                    <input aria-label={t("harness.helperName")} name="helper-name" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
                  </label>
                  <label className="harness-field">
                    <span>{t("harness.helperUrl")}</span>
                    <input aria-label={t("harness.helperUrl")} name="helper-url" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
                  </label>
                  <label className="harness-field">
                    <span>{draft.id ? t("harness.newToken") : t("harness.token")}</span>
                    <input aria-label={t("harness.token")} name="helper-token" type="password" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value, clearToken: false })} autoComplete="off" />
                  </label>
                  {draft.id && (
                    <label>
                      <input type="checkbox" aria-label={t("harness.clearToken")} checked={draft.clearToken} onChange={(event) => setDraft({ ...draft, clearToken: event.target.checked, token: "" })} />
                      {t("harness.clearToken")}
                    </label>
                  )}
                </form>
              )}
              {step === 2 && (
                <div className="harness-routes">
                  <p className="bench-sheet__hint">{t("harness.routesHelp")}</p>
                  {draft.routes.map((route, index) => (
                    <div key={`${route.harness}-${index}`}>
                      <strong>{HARNESSES.find((item) => item.id === route.harness)?.label || route.harness}</strong>
                      <div className="harness-route">
                        <select
                          aria-label={t("harness.sparkFor", { harness: route.harness })}
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
                          <option value="">{t("harness.unassigned")}</option>
                          {sparks.map((spark) => (
                            <option key={spark.id} value={spark.id}>{spark.name}</option>
                          ))}
                        </select>
                        <input
                          aria-label={t("harness.portFor", { harness: route.harness })}
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
                        <span>{t("harness.directoryPrefix")}</span>
                        <input
                          aria-label={t("harness.directoryPrefixFor", { harness: route.harness })}
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
                    {checking ? t("actions.checking") : t("harness.checkConnection")}
                  </button>
                  {check && (
                    <>
                      <p>{t("harness.sessions", { count: check.rowCount })}</p>
                      <ul className="harness-check-list">
                        {Object.entries(check.adapters).map(([id, adapter]) => (
                          <li key={id}>{id}: {adapter.coverage}{adapter.stale ? `, ${t("harness.stale")}` : ""}{adapter.error ? ` (${adapter.error})` : ""}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
              {step === 4 && (
                <div>
                  <p>{draft.harnesses.join(", ")} → {draft.url}</p>
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
                {t("actions.back")}
              </button>
              {step < steps.length - 1 ? (
                <button type="button" className="btn btn--primary" onClick={goNext}>{t("actions.next")}</button>
              ) : (
                <button type="button" className="btn btn--primary" onClick={() => void saveDraft()} disabled={saving}>
                  {saving ? t("actions.saving") : t("actions.save")}
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
