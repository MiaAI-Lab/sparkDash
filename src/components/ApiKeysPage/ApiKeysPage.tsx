import { useCallback, useEffect, useState } from "react";
import { fetchApiKey, fetchApiKeys, fetchApiKeysStatus, type ApiKeyRecord, type ApiKeysStatus } from "../../api/apiKeysClient";
import { fmtBudget, fmtDate, fmtLimit, fmtUsd, shortId, UNKNOWN } from "./apiKeysFormat";
import "../../styles/tokens.css";
import "../../styles/apikeys.css";

/** Read-only API Keys page: LiteLLM virtual keys as reported by the host-side bridge. */
export function ApiKeysPage() {
  const [status, setStatus] = useState<ApiKeysStatus | null>(null);
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ApiKeyRecord | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
          <h1>API Keys</h1>
          <p className="page-head__sub">LiteLLM virtual keys, read-only, through the host-side bridge.</p>
        </div>
        <div className="page-head__tools">
          <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {status ? (
        <p className="ak-status" role="status">
          <span className={`ak-pill ak-pill--${status.bridge === "ok" ? "active" : "down"}`}>Bridge {status.bridge}</span>{" "}
          <span className={`ak-pill ak-pill--${status.upstream === "ok" ? "active" : status.upstream === "down" ? "down" : "unknown"}`}>LiteLLM {status.upstream}</span>
          {status.retryAfterSec ? <span className="tk-faint"> retrying in {status.retryAfterSec} s</span> : null}
        </p>
      ) : null}

      {error ? (
        <div className="panel tk-note tk-note--err" role="alert">
          Could not load keys: {error}
        </div>
      ) : null}

      {keys ? (
        <section className="panel tk-card" aria-labelledby="ak-keys-title">
          <div className="tk-card__head">
            <h2 id="ak-keys-title" className="tk-card__title">
              Keys ({keys.length})
            </h2>
          </div>
          {keys.length === 0 ? (
            <p className="tk-card__sub">The bridge reports no keys.</p>
          ) : (
            <div className="tk-scroll">
              <table className="tk-table ak-table">
                <thead>
                  <tr>
                    <th scope="col">Key</th>
                    <th scope="col">State</th>
                    <th scope="col" className="ak-num">Spend</th>
                    <th scope="col">Budget</th>
                    <th scope="col" className="ak-num">RPM</th>
                    <th scope="col" className="ak-num">TPM</th>
                    <th scope="col">Expires</th>
                    <th scope="col">Last active</th>
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
                        <span className={`ak-pill ak-pill--${k.state}`}>{k.state}</span>
                      </td>
                      <td className={`ak-num${k.spend == null ? " ak-unknown" : ""}`}>{fmtUsd(k.spend)}</td>
                      <td>{fmtBudget(k.maxBudget, k.budgetDuration)}</td>
                      <td className="ak-num">{fmtLimit(k.rpmLimit)}</td>
                      <td className="ak-num">{fmtLimit(k.tpmLimit)}</td>
                      <td>{fmtDate(k.expires)}</td>
                      <td>{fmtDate(k.lastActive)}</td>
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
          Could not load key: {detailError}
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
            <dt>Spend</dt>
            <dd>{fmtUsd(selected.spend)}</dd>
            <dt>Budget</dt>
            <dd>{fmtBudget(selected.maxBudget, selected.budgetDuration)}</dd>
            <dt>Budget resets</dt>
            <dd>{fmtDate(selected.budgetResetAt)}</dd>
            <dt>Parallel requests</dt>
            <dd>{fmtLimit(selected.maxParallelRequests)}</dd>
            <dt>Created</dt>
            <dd>{fmtDate(selected.createdAt)}</dd>
            <dt>Models</dt>
            <dd>{selected.models.length ? selected.models.join(", ") : "all"}</dd>
          </dl>
          {selected.spend == null ? <p className="tk-card__sub">Spend is {UNKNOWN}: the bridge did not report it for this key.</p> : null}
        </section>
      ) : null}
    </div>
  );
}
