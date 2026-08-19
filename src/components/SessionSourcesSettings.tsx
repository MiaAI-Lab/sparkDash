import { useEffect, useState } from "react";
import { fetchSessionSources, testSessionSources, updateSessionSources } from "../api/client";
import type {
  SessionSourceAttach,
  SessionSources,
  SessionSourcesHealth,
  SessionSourcesPatch,
} from "../api/types";
import { SessionSourcesPanel, nextAttachId, sourceKinds } from "./SessionSourcesPanel";

function attachPatch(
  src: SessionSourceAttach,
  tokenDrafts: Record<string, string>,
  clearTokens: Record<string, boolean>
) {
  const draft = tokenDrafts[src.id] ?? "";
  return {
    id: src.id,
    label: src.label ?? "",
    enabled: src.enabled,
    mode: src.mode,
    url: src.url,
    stateDir: src.stateDir,
    username: src.username ?? "",
    ...(clearTokens[src.id] && !draft ? { token: "" } : draft ? { token: draft } : {}),
  };
}

function testBody(
  sources: SessionSources,
  tokenDrafts: Record<string, string>,
  clearTokens: Record<string, boolean>
): SessionSourcesPatch {
  return Object.fromEntries(
    sourceKinds(sources).map((kind) => [
      kind,
      sources[kind].map((src) => attachPatch(src, tokenDrafts, clearTokens)),
    ])
  );
}

/**
 * Dashboard occupancy attaches. Shown on LLM settings (not global Settings).
 * Saves independently of the Spark LLM port.
 */
export function SessionSourcesSettings() {
  const [sessionSources, setSessionSources] = useState<SessionSources | null>(null);
  const [tokenDrafts, setTokenDrafts] = useState<Record<string, string>>({});
  const [clearTokens, setClearTokens] = useState<Record<string, boolean>>({});
  const [sourceHealth, setSourceHealth] = useState<SessionSourcesHealth | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSessionSources()
      .then((sources) => {
        if (cancelled) return;
        setSessionSources(sources);
        setCheckingId("*");
        return testSessionSources(testBody(sources, {}, {})).then((result) => {
          if (!cancelled) setSourceHealth(result);
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setCheckingId(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patchSource = (kind: string, id: string, patch: Partial<SessionSourceAttach>) => {
    setSessionSources((prev) =>
      prev
        ? {
            ...prev,
            [kind]: (prev[kind] ?? []).map((row) => (row.id === id ? { ...row, ...patch } : row)),
          }
        : prev
    );
    setDirty(true);
  };

  const addSource = (kind: string) => {
    setSessionSources((prev) => {
      if (!prev) return prev;
      const id = nextAttachId(kind, prev[kind] ?? []);
      const template = prev[kind]?.[0];
      const blank: SessionSourceAttach = {
        id,
        label: "",
        enabled: true,
        mode: template?.urlPlaceholder ? "url" : "local",
        url: "",
        stateDir: "",
        username: "",
        hasToken: false,
        conventionalStateDir: template?.conventionalStateDir ?? "",
        conventionalConfigDir: template?.conventionalConfigDir,
        urlPlaceholder: template?.urlPlaceholder,
        usesUsername: template?.usesUsername,
        kindLabel: template?.kindLabel,
      };
      return { ...prev, [kind]: [...(prev[kind] ?? []), blank] };
    });
    setDirty(true);
  };

  const removeSource = (kind: string, id: string) => {
    setSessionSources((prev) =>
      prev ? { ...prev, [kind]: (prev[kind] ?? []).filter((row) => row.id !== id) } : prev
    );
    setTokenDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setClearTokens((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setDirty(true);
  };

  const runCheck = async (sources: SessionSources, attachId?: string) => {
    setCheckingId(attachId ?? "*");
    setError(null);
    try {
      setSourceHealth(await testSessionSources(testBody(sources, tokenDrafts, clearTokens)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingId(null);
    }
  };

  const handleSave = async () => {
    if (!sessionSources) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateSessionSources(testBody(sessionSources, tokenDrafts, clearTokens));
      setSessionSources(saved);
      setTokenDrafts({});
      setClearTokens({});
      setDirty(false);
      await runCheck(saved);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-[10px] text-muted">Loading occupancy sources…</p>;
  }
  if (!sessionSources) {
    return error ? <p className="text-[10px] text-danger">{error}</p> : null;
  }

  return (
    <div className="space-y-3">
      <SessionSourcesPanel
        sources={sessionSources}
        tokenDrafts={tokenDrafts}
        health={sourceHealth}
        checkingId={checkingId}
        onPatch={patchSource}
        onToken={(id, value) => {
          setTokenDrafts((prev) => ({ ...prev, [id]: value }));
          if (value) setClearTokens((prev) => ({ ...prev, [id]: false }));
          setDirty(true);
        }}
        onClearToken={(kind, id) => {
          setTokenDrafts((prev) => ({ ...prev, [id]: "" }));
          setClearTokens((prev) => ({ ...prev, [id]: true }));
          patchSource(kind, id, { hasToken: false });
        }}
        onCheck={(id) => void runCheck(sessionSources, id)}
        onAdd={addSource}
        onRemove={removeSource}
      />
      {error && <p className="text-[10px] text-danger">{error}</p>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save occupancy"}
        </button>
      </div>
    </div>
  );
}
