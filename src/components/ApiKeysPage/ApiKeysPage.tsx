import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchApiKey, fetchApiKeys, fetchApiKeysStatus, type ApiKeyRecord, type ApiKeysStatus } from "../../api/apiKeysClient";
import { fmtBudget, fmtDate, fmtLimit, fmtUsd, shortId } from "./apiKeysFormat";
import "../../styles/tokens.css";
import "../../styles/apikeys.css";

type Translate = (key: string, options?: Record<string, unknown>) => string;

function statusStateLabel(t: Translate, state: string): string {
  switch (state) {
    case "ok": return t("states.ok");
    case "down": return t("states.down");
    case "unconfigured": return t("states.unconfigured");
    case "unknown": return t("states.unknown");
    default: return state;
  }
}

function keyStateLabel(t: Translate, state: string): string {
  switch (state) {
    case "active": return t("states.active");
    case "blocked": return t("states.blocked");
    case "expired": return t("states.expired");
    case "unknown": return t("states.unknown");
    default: return state;
  }
}

/** Read-only API Keys page: LiteLLM virtual keys as reported by the host-side bridge. */
export function ApiKeysPage() {
  const { t } = useTranslation("apiKeys");
  const [status, setStatus] = useState<ApiKeysStatus | null>(null);
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ApiKeyRecord | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const formatLabels = { unknown: t("unknown"), unlimited: t("unlimited") };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [st, list] = await Promise.allSettled([fetchApiKeysStatus(), fetchApiKeys()]);
    setStatus(st.status === "fulfilled" ? st.value : null);
    if (list.status === "fulfilled") setKeys(list.value.keys);
    else {
      setKeys(null);
      setError(list.reason instanceof Error ? list.reason.message : String(list.reason));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    setDetailError(null);
    try {
      setSelected((await fetchApiKey(id)).key);
    } catch (err) {
      setSelected(null);
      setDetailError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="tk ak">
      <header className="page-head ak-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-head__sub">{t("subtitle")}</p>
        </div>
        <div className="page-head__tools">
          <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={loading}>
            {loading ? t("refreshing") : t("refresh")}
          </button>
        </div>
      </header>

      {status ? (
        <p className="ak-status" role="status">
          <span className={`ak-pill ak-pill--${status.bridge === "ok" ? "active" : "down"}`}>{t("status.bridge", { state: statusStateLabel(t, status.bridge) })}</span>{" "}
          <span className={`ak-pill ak-pill--${status.upstream === "ok" ? "active" : status.upstream === "down" ? "down" : "unknown"}`}>{t("status.upstream", { state: statusStateLabel(t, status.upstream) })}</span>
          {status.retryAfterSec ? <span className="tk-faint"> {t("status.retrying", { seconds: status.retryAfterSec })}</span> : null}
        </p>
      ) : null}

      {error ? (
        <div className="panel tk-note tk-note--err" role="alert">
          {t("errors.keys", { error })}
        </div>
      ) : null}

      {keys ? (
        <section className="panel tk-card" aria-labelledby="ak-keys-title">
          <div className="tk-card__head">
            <h2 id="ak-keys-title" className="tk-card__title">
              {t("keys.title", { count: keys.length })}
            </h2>
          </div>
          {keys.length === 0 ? (
            <p className="tk-card__sub">{t("keys.empty")}</p>
          ) : (
            <div className="tk-scroll">
              <table className="tk-table ak-table">
                <thead>
                  <tr>
                    <th scope="col">{t("table.key")}</th>
                    <th scope="col">{t("table.state")}</th>
                    <th scope="col" className="ak-num">{t("table.spend")}</th>
                    <th scope="col">{t("table.budget")}</th>
                    <th scope="col" className="ak-num">{t("table.rpm")}</th>
                    <th scope="col" className="ak-num">{t("table.tpm")}</th>
                    <th scope="col">{t("table.expires")}</th>
                    <th scope="col">{t("table.lastActive")}</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className={selected?.id === k.id ? "is-selected" : undefined}>
                      <td>
                        <button type="button" className="ak-link" onClick={() => void open(k.id)}>
                          {k.alias ?? shortId(k.id)}
                        </button>
                        <span className="ak-sub">{shortId(k.id)}</span>
                      </td>
                      <td>
                        <span className={`ak-pill ak-pill--${k.state}`}>{keyStateLabel(t, k.state)}</span>
                      </td>
                      <td className={`ak-num${k.spend == null ? " ak-unknown" : ""}`}>{fmtUsd(k.spend, formatLabels)}</td>
                      <td>{fmtBudget(k.maxBudget, k.budgetDuration, formatLabels)}</td>
                      <td className="ak-num">{fmtLimit(k.rpmLimit)}</td>
                      <td className="ak-num">{fmtLimit(k.tpmLimit)}</td>
                      <td>{fmtDate(k.expires, formatLabels)}</td>
                      <td>{fmtDate(k.lastActive, formatLabels)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {detailError ? (
        <div className="panel tk-note tk-note--err" role="alert">
          {t("errors.key", { error: detailError })}
        </div>
      ) : null}

      {selected ? (
        <section className="panel tk-card" aria-labelledby="ak-detail-title">
          <div className="tk-card__head">
            <h2 id="ak-detail-title" className="tk-card__title">
              {selected.alias ?? shortId(selected.id)}
            </h2>
          </div>
          <dl className="ak-detail">
            <dt>{t("detail.spend")}</dt>
            <dd>{fmtUsd(selected.spend, formatLabels)}</dd>
            <dt>{t("detail.budget")}</dt>
            <dd>{fmtBudget(selected.maxBudget, selected.budgetDuration, formatLabels)}</dd>
            <dt>{t("detail.budgetResets")}</dt>
            <dd>{fmtDate(selected.budgetResetAt, formatLabels)}</dd>
            <dt>{t("detail.parallelRequests")}</dt>
            <dd>{fmtLimit(selected.maxParallelRequests)}</dd>
            <dt>{t("detail.created")}</dt>
            <dd>{fmtDate(selected.createdAt, formatLabels)}</dd>
            <dt>{t("detail.models")}</dt>
            <dd>{selected.models.length ? selected.models.join(", ") : t("all")}</dd>
          </dl>
          {selected.spend == null ? <p className="tk-card__sub">{t("detail.spendUnknown", { unknown: t("unknown") })}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
