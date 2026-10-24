import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import {
  fetchAuthStatus,
  onSessionChange,
  onTokenChange,
  requestTokenPrompt,
  type AuthStatus,
} from "../api/authToken";
import {
  enrolPasskey,
  isPasskeyCancelled,
  listPasskeys,
  revokePasskey,
  signOut,
  type Passkey,
  type PasskeyList,
} from "../api/passkeys";
import { SettingRow } from "./SettingRows";

/**
 * Settings → Passkeys. Shown only when the host arms passkey sign-in. Like the
 * Access token row it lives outside the settings block: it works (and matters
 * most) when settings cannot load. Enrol and revoke need the token's authority,
 * which the server reports as `canManage`.
 */
export function PasskeySettings(): ReactElement | null {
  const { t, i18n } = useTranslation("settings");
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [list, setList] = useState<PasskeyList | null>(null);
  const [label, setLabel] = useState("");
  /** "enrol", "signOut", or the id of the passkey being revoked. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const reload = () => setReloadKey((k) => k + 1);
    const offSession = onSessionChange(reload);
    const offToken = onTokenChange(reload);
    return () => {
      offSession();
      offToken();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAuthStatus()
      .then(async (next) => {
        if (cancelled) return;
        setStatus(next);
        if (!next.passkeys.enabled || !next.authenticated) {
          setList(null);
          return;
        }
        try {
          const passkeys = await listPasskeys();
          if (cancelled) return;
          setList(passkeys);
          setError(null);
        } catch (err) {
          if (cancelled) return;
          setList(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .catch(() => {
        // Server unreachable: an older or absent server has no passkeys to show.
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (!status?.passkeys.enabled) return null;

  const session = status.session;
  let sessionLabel = t("passkeys.signedOut");
  if (session?.method === "passkey") {
    sessionLabel = t("passkeys.signedInPasskey");
  } else if (session?.method === "token") {
    sessionLabel = t("passkeys.signedInToken");
  }
  const supported = browserSupportsWebAuthn();
  function formatDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "short" });
  }

  async function run(key: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      setReloadKey((k) => k + 1);
    } catch (err) {
      if (isPasskeyCancelled(err)) setNotice(t("passkeys.cancelled"));
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleEnrol(): Promise<void> {
    await run("enrol", async () => {
      await enrolPasskey(label);
      setLabel("");
    });
  }

  function handleRevoke(passkey: Passkey): void {
    const name = passkey.label || t("passkeys.unnamed");
    if (!window.confirm(t("passkeys.revokeConfirm", { label: name }))) return;
    void run(passkey.id, () => revokePasskey(passkey.id));
  }

  return (
    <SettingRow title={t("passkeys.title")} help={t("passkeys.help")} stack>
      <div className="set-passkeys">
        <div className="set-token">
          <span className={`set-token__state${session ? " is-set" : ""}`} data-testid="passkey-session-state">
            <i aria-hidden />
            {sessionLabel}
          </span>
          {session ? (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={busy !== null}
              onClick={() => void run("signOut", signOut)}
            >
              {t("passkeys.signOut")}
            </button>
          ) : (
            <button type="button" className="btn btn--sm" onClick={() => requestTokenPrompt()}>
              {t("passkeys.signIn")}
            </button>
          )}
        </div>

        {list ? (
          <>
            {list.passkeys.length > 0 ? (
              <ul className="set-passkeys__list" aria-label={t("passkeys.listLabel")}>
                {list.passkeys.map((passkey) => (
                  <li key={passkey.id} className="set-passkeys__item">
                    <div className="set-passkeys__text">
                      <span className="set-passkeys__label">{passkey.label || t("passkeys.unnamed")}</span>
                      <small>
                        {t("passkeys.created", { date: formatDate(passkey.createdAt) })}
                        {" · "}
                        {passkey.lastUsedAt
                          ? t("passkeys.lastUsed", { date: formatDate(passkey.lastUsedAt) })
                          : t("passkeys.neverUsed")}
                      </small>
                    </div>
                    {list.canManage ? (
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        disabled={busy !== null}
                        onClick={() => handleRevoke(passkey)}
                      >
                        {busy === passkey.id ? t("passkeys.revoking") : t("passkeys.revoke")}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="set-passkeys__hint">{t("passkeys.none")}</p>
            )}
            {list.canManage ? (
              <>
                <div className="set-passkeys__add">
                  <input
                    type="text"
                    className="field-input"
                    aria-label={t("passkeys.labelAria")}
                    placeholder={t("passkeys.labelPlaceholder")}
                    maxLength={64}
                    value={label}
                    disabled={busy !== null}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busy !== null || !supported}
                    onClick={() => void handleEnrol()}
                  >
                    {busy === "enrol" ? t("passkeys.adding") : t("passkeys.add")}
                  </button>
                </div>
                {!supported && <span className="set-row__note">{t("passkeys.unsupported")}</span>}
              </>
            ) : (
              <p className="set-passkeys__hint">{t("passkeys.manageNeedsToken")}</p>
            )}
          </>
        ) : null}
        {!list && !status.authenticated && (
          <p className="set-passkeys__hint">{t("passkeys.signInToList")}</p>
        )}

        {notice && (
          <p className="set-passkeys__hint" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="set-passkeys__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </SettingRow>
  );
}
