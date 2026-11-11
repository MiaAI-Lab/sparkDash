import { useCallback, useEffect, useMemo, useState } from "react";
import { forgetStorageSudo } from "../../api/client";
import type { StorageElevation, StorageStatus } from "../../api/types";

export interface AdminAccess {
  /** "root": already administrator. "yes": passwordless sudo. "no": a password is needed. */
  sudo: StorageStatus["sudo"];
  /** A password may be typed here: https, or the dashboard is on the Spark itself. */
  canTypePassword: boolean;
  /** Administrator rights can be used at all from this connection. */
  available: boolean;
  needsPassword: boolean;
  /** The dashboard remembers the password for this Spark's account: nothing to type. */
  saved: boolean;
  password: string;
  setPassword: (value: string) => void;
  /** Keep a typed password on the dashboard (encrypted) once sudo accepts it. */
  remember: boolean;
  setRemember: (value: boolean) => void;
  /** Drop the typed password from memory (and re-read what the dashboard remembers). */
  forget: () => void;
  /** Make the dashboard forget the remembered password. */
  forgetSaved: () => Promise<void>;
  /** Ready to run something as administrator: nothing more to type. */
  ready: boolean;
  /** The request fields for an action, as administrator or not. */
  elevation: (asAdmin: boolean) => StorageElevation;
}

/**
 * Administrator (sudo) access for one Spark. A typed password lives in this page's memory and is sent with
 * each request that needs it. With "remember" ticked the server keeps it, encrypted, once sudo has accepted
 * it, and from then on nothing needs typing, even after a reload. `refreshStatus` re-reads what the dashboard
 * remembers (after a password was used or forgotten).
 */
export function useAdminAccess(sparkId: string | null, status: StorageStatus | null, refreshStatus?: () => void): AdminAccess {
  const [password, setPassword] = useState("");
  // Off unless the person ticks it: remembering a password lets anyone using the dashboard run sudo actions.
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    setPassword("");
  }, [sparkId]);

  const sudo = status?.sudo ?? "no";
  const saved = status?.sudoSaved === true;
  const canTypePassword =
    (typeof window === "undefined" || window.isSecureContext !== false || status?.plainPasswordAllowed === true) &&
    status?.passwordAllowed !== false;
  const needsPassword = sudo === "no";
  // A remembered password needs no typing, so it works from any connection.
  const available = !needsPassword || canTypePassword || saved;
  const ready = !needsPassword || password.length > 0 || saved;
  const forget = useCallback(() => {
    setPassword("");
    refreshStatus?.();
  }, [refreshStatus]);
  const forgetSaved = useCallback(async () => {
    if (sparkId) await forgetStorageSudo(sparkId);
    refreshStatus?.();
  }, [sparkId, refreshStatus]);
  const elevation = useCallback(
    (asAdmin: boolean): StorageElevation =>
      !asAdmin ? {} : needsPassword && password ? { sudo: true, sudoPassword: password, remember } : { sudo: true },
    [needsPassword, password, remember]
  );

  return useMemo(
    () => ({ sudo, canTypePassword, available, needsPassword, saved, password, setPassword, remember, setRemember, forget, forgetSaved, ready, elevation }),
    [sudo, canTypePassword, available, needsPassword, saved, password, remember, forget, forgetSaved, ready, elevation]
  );
}
