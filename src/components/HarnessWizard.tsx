import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchSessionSources,
  testSessionSources,
  updateSessionSources,
} from "../api/client";
import type {
  SessionSourceAttach,
  SessionSourcePatch,
  SessionSources,
  SessionSourcesHealth,
  SessionSourcesPatch,
} from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import "./HarnessWizard.css";

interface HarnessWizardProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface HarnessConfigDraft {
  attachId: string;
  mode: "local" | "remote";
  url: string;
  token: string;
  stateDir: string;
  label: string;
  username: string;
}

interface CheckResult {
  ok: boolean;
  message: string;
}

type StepPhase = "pick" | "configure" | "review";

interface WizardStep {
  phase: StepPhase;
  kind?: string;
  label?: string;
}

function draftFromAttach(attach: SessionSourceAttach): HarnessConfigDraft {
  const isRemote = attach.mode === "url" || Boolean(attach.remoteOnly);
  return {
    attachId: attach.id,
    mode: isRemote ? "remote" : "local",
    url: attach.url || "",
    token: "",
    stateDir: attach.stateDir || attach.conventionalStateDir || "",
    label: attach.label || "",
    username: attach.username || "",
  };
}

function draftToPatch(draft: HarnessConfigDraft, kind: string): SessionSourcePatch {
  return {
    id: draft.attachId || kind,
    enabled: true,
    mode: draft.mode === "local" ? "state-dir" : "url",
    url: draft.mode === "remote" ? draft.url : "",
    stateDir: draft.mode === "local" ? draft.stateDir : "",
    label: draft.label || undefined,
    username: draft.username || undefined,
    ...(draft.token ? { token: draft.token } : {}),
  };
}

function buildPatch(
  selectedKinds: string[],
  disabledKinds: string[],
  configs: Record<string, HarnessConfigDraft>,
  sources: SessionSources | null
): SessionSourcesPatch {
  const patch: SessionSourcesPatch = {};
  for (const kind of selectedKinds) {
    const draft = configs[kind];
    if (draft) patch[kind] = draftToPatch(draft, kind);
  }
  for (const kind of disabledKinds) {
    const attaches = sources?.[kind] ?? [];
    patch[kind] = attaches.map((a) => ({ id: a.id, enabled: false }));
  }
  return patch;
}

export function HarnessWizard({ open, onClose, onSaved }: HarnessWizardProps) {
  const { mounted, visible } = useModalPresence(open, 240, { escapeOnClose: onClose });

  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<SessionSources | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [configs, setConfigs] = useState<Record<string, HarnessConfigDraft>>({});
  const [snippetMode, setSnippetMode] = useState<Record<string, "human" | "agent">>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [checkResults, setCheckResults] = useState<Record<string, CheckResult | null>>({});
  const [stepIdx, setStepIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const didLoadSources = useRef(false);

  // Load session sources when wizard opens
  useEffect(() => {
    if (!open || didLoadSources.current) return;
    didLoadSources.current = true;
    setLoading(true);
    setLoadError(null);
    fetchSessionSources()
      .then((data) => {
        setSources(data);
        // Pre-check harnesses that already have enabled attaches
        const preSelected = new Set<string>();
        const preConfigs: Record<string, HarnessConfigDraft> = {};
        for (const [kind, attaches] of Object.entries(data)) {
          const enabled = attaches.find((a) => a.enabled);
          if (enabled) {
            preSelected.add(kind);
            preConfigs[kind] = draftFromAttach(enabled);
          }
        }
        setSelected(preSelected);
        setConfigs(preConfigs);
      })
      .catch((err) => setLoadError(err.message || "Failed to load harnesses"))
      .finally(() => setLoading(false));
  }, [open]);

  // Reset transient state when wizard closes
  useEffect(() => {
    if (!open) {
      didLoadSources.current = false;
      setStepIdx(0);
      setSaveError(null);
      setCheckResults({});
      setChecking({});
    }
  }, [open]);

  const allKinds = useMemo<SessionSourceAttach[]>(() => {
    if (!sources) return [];
    // Collect one representative attach per kind (first attach carries metadata)
    const result: SessionSourceAttach[] = [];
    for (const attaches of Object.values(sources)) {
      if (attaches.length > 0) {
        result.push(attaches[0]);
      }
    }
    return result;
  }, [sources]);

  // Build the step sequence: pick → one per selected → review
  const stepSequence = useMemo<WizardStep[]>(() => {
    const steps: WizardStep[] = [{ phase: "pick", label: "Select harnesses" }];
    const selectedKinds = allKinds.filter((k) => selected.has(k.id));
    for (const kind of selectedKinds) {
      steps.push({ phase: "configure", kind: kind.id, label: kind.kindLabel || kind.id });
    }
    steps.push({ phase: "review", label: "Review and save" });
    return steps;
  }, [allKinds, selected]);

  const currentStep = stepSequence[stepIdx] || stepSequence[0];
  const totalSteps = stepSequence.length;

  // Derive the attach for the current configure step once, no repeated find() + !
  const currentAttach = useMemo(() => {
    if (currentStep.phase !== "configure" || !currentStep.kind) return null;
    return allKinds.find((k) => k.id === currentStep.kind) ?? null;
  }, [allKinds, currentStep]);

  const toggleKind = useCallback((kindId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kindId)) next.delete(kindId);
      else next.add(kindId);
      return next;
    });
    // Initialize config draft from the attach metadata if not already present
    setConfigs((prev) => {
      if (prev[kindId]) return prev;
      const attach = allKinds.find((k) => k.id === kindId);
      if (!attach) return prev;
      return { ...prev, [kindId]: draftFromAttach(attach) };
    });
  }, [allKinds]);

  const updateConfig = useCallback((kindId: string, patch: Partial<HarnessConfigDraft>) => {
    setConfigs((prev) => ({
      ...prev,
      [kindId]: { ...prev[kindId], ...patch },
    }));
  }, []);

  const handleCheck = useCallback(
    async (kindId: string) => {
      setChecking((prev) => ({ ...prev, [kindId]: true }));
      setCheckResults((prev) => ({ ...prev, [kindId]: null }));
      try {
        const draft = configs[kindId];
        if (!draft) return;
        const patch: SessionSourcesPatch = { [kindId]: draftToPatch(draft, kindId) };
        const health: SessionSourcesHealth = await testSessionSources(patch);
        const entry = health[kindId]?.[0];
        if (entry) {
          setCheckResults((prev) => ({
            ...prev,
            [kindId]: {
              ok: entry.status === "ok",
              message: entry.status === "ok"
                ? `Connected — ${entry.found} session${entry.found === 1 ? "" : "s"} found`
                : entry.error || "Check failed",
            },
          }));
        } else {
          setCheckResults((prev) => ({
            ...prev,
            [kindId]: { ok: false, message: "No response from server" },
          }));
        }
      } catch (err) {
        setCheckResults((prev) => ({
          ...prev,
          [kindId]: { ok: false, message: (err as Error).message || "Check failed" },
        }));
      } finally {
        setChecking((prev) => ({ ...prev, [kindId]: false }));
      }
    },
    [configs]
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const selectedKinds = allKinds.filter((k) => selected.has(k.id)).map((k) => k.id);
      const disabledKinds = allKinds
        .filter((k) => !selected.has(k.id) && sources?.[k.id]?.some((a) => a.enabled))
        .map((k) => k.id);
      const patch = buildPatch(selectedKinds, disabledKinds, configs, sources);
      await updateSessionSources(patch);
      onSaved();
      onClose();
    } catch (err) {
      setSaveError((err as Error).message || "Failed to save harnesses");
    } finally {
      setSaving(false);
    }
  }, [allKinds, selected, configs, sources, onSaved, onClose]);

  if (!mounted) return null;

  const canAdvance =
    currentStep.phase === "pick" ? selected.size > 0 : true;

  const handleNext = () => {
    if (stepIdx < totalSteps - 1) setStepIdx(stepIdx + 1);
  };
  const handleBack = () => {
    if (stepIdx > 0) setStepIdx(stepIdx - 1);
  };

  const title =
    currentStep.phase === "pick"
      ? "Connect your harnesses"
      : currentStep.phase === "review"
      ? "Review and save"
      : `Configure ${currentStep.label}`;

  const subtitle =
    currentStep.phase === "pick"
      ? "Select all the coding-agent harnesses you use, then configure each one."
      : currentStep.phase === "review"
      ? "Confirm your harness connections before saving."
      : "Set up how SparkDash reaches this harness.";

  return createPortal(
    <div
      className={`harness-wizard-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="harness-wizard-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="harness-wizard-title"
      >
        <div className="harness-wizard__header">
          <div className="harness-wizard__header-row">
            <div className="harness-wizard__header-text">
              <h2 id="harness-wizard-title" className="harness-wizard__title">
                {title}
              </h2>
              <p className="harness-wizard__subtitle">{subtitle}</p>
            </div>
            <button
              type="button"
              className="harness-wizard__close"
              onClick={onClose}
              aria-label="Close"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="harness-wizard__step-indicator">
            <span className="harness-wizard__step-compact">
              Step {stepIdx + 1} of {totalSteps}
            </span>
            <div className="harness-wizard__step-track">
              {stepSequence.map((s, i) => (
                <div
                  key={i}
                  className={`harness-wizard__step-node${i === stepIdx ? " is-current" : ""}${i < stepIdx ? " is-done" : ""}`}
                >
                  <span className="harness-wizard__step-node-dot" />
                  {i < stepSequence.length - 1 && (
                    <span className="harness-wizard__step-node-line" />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="harness-wizard__body">
          {loading && <p className="text-xs text-muted">Loading harnesses…</p>}
          {loadError && (
            <div className="harness-wizard__error">{loadError}</div>
          )}

          {!loading && currentStep.phase === "pick" && (
            <PickStep
              allKinds={allKinds}
              selected={selected}
              onToggle={toggleKind}
            />
          )}

          {!loading && currentStep.phase === "configure" && currentStep.kind && currentAttach && (() => {
            const kind = currentStep.kind;
            return (
              <ConfigureStep
                kindId={kind}
                attach={currentAttach}
                draft={configs[kind] || draftFromAttach(currentAttach)}
                snippetMode={snippetMode[kind] || "human"}
                onSnippetModeChange={(mode) => setSnippetMode((prev) => ({ ...prev, [kind]: mode }))}
                onUpdate={(patch) => updateConfig(kind, patch)}
                onCheck={() => handleCheck(kind)}
                checking={checking[kind] || false}
                checkResult={checkResults[kind] || null}
              />
            );
          })()}

          {!loading && currentStep.phase === "review" && (
            <ReviewStep
              selectedKinds={allKinds.filter((k) => selected.has(k.id))}
              configs={configs}
              checkResults={checkResults}
            />
          )}

          {saveError && (
            <div className="harness-wizard__error harness-wizard__error--save">
              {saveError}
            </div>
          )}
        </div>

        <div className="harness-wizard__footer">
          {currentStep.phase !== "pick" && (
            <button
              type="button"
              className="harness-wizard__btn harness-wizard__btn--ghost"
              onClick={handleBack}
            >
              Back
            </button>
          )}
          <div className="harness-wizard__footer-actions">
            {currentStep.phase !== "review" ? (
              <button
                type="button"
                className="harness-wizard__btn harness-wizard__btn--primary"
                onClick={handleNext}
                disabled={!canAdvance}
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                className="harness-wizard__btn harness-wizard__btn--primary"
                onClick={handleSave}
                disabled={saving || selected.size === 0}
              >
                {saving ? "Saving…" : "Save harnesses"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Step 1: Pick harnesses ──────────────────────────────

function PickStep({
  allKinds,
  selected,
  onToggle,
}: {
  allKinds: SessionSourceAttach[];
  selected: Set<string>;
  onToggle: (kindId: string) => void;
}) {
  return (
    <div className="harness-wizard__pick">
      <p className="harness-wizard__pick-intro">
        Select all the coding-agent harnesses you use.
      </p>
      <div className="harness-wizard__cards">
        {allKinds.map((kind) => {
          const kindId = kind.id;
          const isSelected = selected.has(kindId);
          const isHelper = Boolean(kind.helperHuman);
          return (
            <button
              key={kindId}
              type="button"
              className={`harness-wizard__card${isSelected ? " is-selected" : ""}`}
              onClick={() => onToggle(kindId)}
              role="checkbox"
              aria-checked={isSelected}
            >
              <div className="harness-wizard__card-row">
                <div className="harness-wizard__card-check">
                  {isSelected && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </div>
                <div className="harness-wizard__card-content">
                  <div className="harness-wizard__card-label">
                    {kind.kindLabel || kindId}
                    <span className={`harness-wizard__card-tag${isHelper ? " is-helper" : ""}`}>
                      {isHelper ? "Helper" : "Native API"}
                    </span>
                  </div>
                  <div className="harness-wizard__card-desc" title={kind.description}>
                    {kind.description}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Step 2: Configure a single harness ──────────────────

function ConfigureStep({
  kindId,
  attach,
  draft,
  snippetMode,
  onSnippetModeChange,
  onUpdate,
  onCheck,
  checking,
  checkResult,
}: {
  kindId: string;
  attach: SessionSourceAttach;
  draft: HarnessConfigDraft;
  snippetMode: "human" | "agent";
  onSnippetModeChange: (mode: "human" | "agent") => void;
  onUpdate: (patch: Partial<HarnessConfigDraft>) => void;
  onCheck: () => void;
  checking: boolean;
  checkResult: CheckResult | null;
}) {
  const isRemoteOnly = Boolean(attach.remoteOnly);
  const isHelper = Boolean(attach.helperHuman);
  const helperSnippet = snippetMode === "human" ? attach.helperHuman : attach.helperAgent;
  const [copied, setCopied] = useState(false);

  const copySnippet = () => {
    if (helperSnippet) {
      navigator.clipboard.writeText(helperSnippet).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  return (
    <div className="harness-wizard__configure">
      {!isRemoteOnly && (
        <div className="harness-wizard__field-group">
          <label className="harness-wizard__field-label">
            Where does {attach.kindLabel} run?
          </label>
          <div className="harness-wizard__radio-row">
            <button
              type="button"
              className={`harness-wizard__radio${draft.mode === "local" ? " is-active" : ""}`}
              onClick={() => onUpdate({ mode: "local" })}
            >
              This machine
            </button>
            <button
              type="button"
              className={`harness-wizard__radio${draft.mode === "remote" ? " is-active" : ""}`}
              onClick={() => onUpdate({ mode: "remote" })}
            >
              Another machine
            </button>
          </div>
        </div>
      )}

      {draft.mode === "local" && (
        <div className="harness-wizard__field-group">
          <label className="harness-wizard__field-label" htmlFor={`stateDir-${kindId}`}>
            State directory
          </label>
          <input
            id={`stateDir-${kindId}`}
            type="text"
            value={draft.stateDir}
            onChange={(e) => onUpdate({ stateDir: e.target.value })}
            placeholder={attach.conventionalStateDir}
            className="harness-wizard__input"
          />
          <p className="harness-wizard__field-hint">
            Default: {attach.conventionalStateDir}
          </p>
        </div>
      )}

      {draft.mode === "remote" && (
        <>
          {isHelper && helperSnippet && (
            <div className="harness-wizard__field-group">
              <div className="harness-wizard__snippet-header">
                <div className="harness-wizard__snippet-toggle">
                  <button
                    type="button"
                    className={`harness-wizard__toggle-btn${snippetMode === "human" ? " is-active" : ""}`}
                    onClick={() => onSnippetModeChange("human")}
                  >
                    Run it yourself
                  </button>
                  <button
                    type="button"
                    className={`harness-wizard__toggle-btn${snippetMode === "agent" ? " is-active" : ""}`}
                    onClick={() => onSnippetModeChange("agent")}
                  >
                    Have an agent set it up
                  </button>
                </div>
                <button
                  type="button"
                  className="harness-wizard__copy-btn"
                  onClick={copySnippet}
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <pre className="harness-wizard__snippet">{helperSnippet}</pre>
              <p className="harness-wizard__field-hint">
                Run this on the machine that hosts {attach.kindLabel}. It prints a URL and token — paste them below.
              </p>
            </div>
          )}

          <div className="harness-wizard__field-group">
            <label className="harness-wizard__field-label" htmlFor={`url-${kindId}`}>
              URL
            </label>
            <input
              id={`url-${kindId}`}
              type="text"
              value={draft.url}
              onChange={(e) => onUpdate({ url: e.target.value })}
              placeholder={attach.urlPlaceholder}
              className="harness-wizard__input"
            />
          </div>

          {attach.usesUsername && (
            <div className="harness-wizard__field-group">
              <label className="harness-wizard__field-label" htmlFor={`username-${kindId}`}>
                Username
              </label>
              <input
                id={`username-${kindId}`}
                type="text"
                value={draft.username}
                onChange={(e) => onUpdate({ username: e.target.value })}
                placeholder="admin"
                className="harness-wizard__input"
              />
            </div>
          )}

          <div className="harness-wizard__field-group">
            <label className="harness-wizard__field-label" htmlFor={`token-${kindId}`}>
              Token
            </label>
            <input
              id={`token-${kindId}`}
              type="password"
              value={draft.token}
              onChange={(e) => onUpdate({ token: e.target.value })}
              placeholder="Paste the token from the helper"
              className="harness-wizard__input"
            />
          </div>

          <div className="harness-wizard__field-group">
            <label className="harness-wizard__field-label" htmlFor={`label-${kindId}`}>
              Label (optional)
            </label>
            <input
              id={`label-${kindId}`}
              type="text"
              value={draft.label}
              onChange={(e) => onUpdate({ label: e.target.value })}
              placeholder="e.g. theshop"
              className="harness-wizard__input"
            />
          </div>
        </>
      )}

      <div className="harness-wizard__check-row">
        <button
          type="button"
          className="harness-wizard__btn harness-wizard__btn--ghost"
          onClick={onCheck}
          disabled={checking || (draft.mode === "remote" && !draft.url)}
        >
          {checking ? "Checking…" : "Check connection"}
        </button>
        {checkResult && (
          <span className={`harness-wizard__check-result${checkResult.ok ? " is-ok" : " is-fail"}`}>
            {checkResult.ok ? "✓" : "✗"} {checkResult.message}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Step 3: Review ──────────────────────────────────────

function ReviewStep({
  selectedKinds,
  configs,
  checkResults,
}: {
  selectedKinds: SessionSourceAttach[];
  configs: Record<string, HarnessConfigDraft>;
  checkResults: Record<string, CheckResult | null>;
}) {
  if (selectedKinds.length === 0) {
    return <p className="text-xs text-muted">No harnesses selected. Go back and select at least one.</p>;
  }

  return (
    <div className="harness-wizard__review">
      <p className="harness-wizard__pick-intro">
        Review your harnesses before saving.
      </p>
      <div className="harness-wizard__review-list">
        {selectedKinds.map((kind) => {
          const draft = configs[kind.id];
          const result = checkResults[kind.id];
          const status = result ? (result.ok ? "Passed" : "Failed") : "Not checked";
          const statusClass = result ? (result.ok ? "is-ok" : "is-fail") : "is-pending";
          return (
            <div key={kind.id} className="harness-wizard__review-row">
              <div className="harness-wizard__review-label">
                {kind.kindLabel || kind.id}
                {draft?.label && <span className="harness-wizard__review-sublabel">{draft.label}</span>}
              </div>
              <div className="harness-wizard__review-meta">
                <span className="harness-wizard__review-mode">
                  {draft?.mode === "local" ? "Local" : "Remote"}
                </span>
                <span className={`harness-wizard__review-status ${statusClass}`}>
                  {status}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
