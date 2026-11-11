import { useCallback, useEffect, useRef, useState } from "react";
import { adviseStorageDelete } from "../../api/client";
import { ADVICE_TIMEOUT_MS, adviceSatisfied, frictionOf, type AdviceState, type Friction } from "./deleteAdvice";

export interface DeleteAdvice {
  state: AdviceState;
  friction: Friction;
  ticked: boolean;
  setTicked: (ticked: boolean) => void;
  typed: string;
  setTyped: (typed: string) => void;
  /** The check lets the delete go ahead with what was ticked or typed. */
  satisfied: boolean;
  /** Stop waiting for a running check: it then counts as not checked ("review"). */
  skip: () => void;
}

const LOADING: AdviceState = { status: "loading" };

/**
 * The check for the paths a delete dialog shows, asked for each time the dialog opens (`paths` null: closed, and a
 * check still running is dropped). The tick and the typed phrase belong to one set of paths and start empty again
 * for the next.
 */
export function useDeleteAdvice(sparkId: string, paths: readonly string[] | null): DeleteAdvice {
  // Paths never hold a newline (the delete policy refuses them), so this names the set exactly.
  const key = paths && paths.length > 0 ? paths.join("\n") : null;
  // Kept with the set they belong to, so a dialog opened for other paths never shows the last answer, not even once.
  const [answer, setAnswer] = useState<{ key: string; state: AdviceState } | null>(null);
  const [confirm, setConfirm] = useState<{ key: string | null; ticked: boolean; typed: string }>({ key: null, ticked: false, typed: "" });
  const running = useRef<{ key: string; ctrl: AbortController } | null>(null);

  useEffect(() => {
    if (key == null) return;
    const ctrl = new AbortController();
    running.current = { key, ctrl };
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, ADVICE_TIMEOUT_MS);
    adviseStorageDelete(sparkId, key.split("\n"), ctrl.signal)
      .then(
        (advice) => {
          if (!ctrl.signal.aborted) setAnswer({ key, state: { status: "ready", advice } });
        },
        (err: unknown) => {
          // Closed, or the person chose not to wait: that is said elsewhere.
          if (ctrl.signal.aborted && !timedOut) return;
          const message = timedOut ? "The Spark did not answer in time." : err instanceof Error && err.message ? err.message : "The check failed.";
          setAnswer({ key, state: { status: "failed", message } });
        }
      )
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
      if (running.current?.ctrl === ctrl) running.current = null;
      // Closed (or other paths): the next opening checks again from the start, even for the same paths.
      setAnswer(null);
      setConfirm({ key: null, ticked: false, typed: "" });
    };
  }, [sparkId, key]);

  const skip = useCallback(() => {
    const r = running.current;
    if (!r) return;
    r.ctrl.abort();
    setAnswer((prev) => (prev?.key === r.key ? prev : { key: r.key, state: { status: "skipped" } }));
  }, []);

  const state = key != null && answer?.key === key ? answer.state : LOADING;
  const mine = confirm.key === key;
  const ticked = mine && confirm.ticked;
  const typed = mine ? confirm.typed : "";
  const setTicked = useCallback((v: boolean) => setConfirm((c) => ({ key, ticked: v, typed: c.key === key ? c.typed : "" })), [key]);
  const setTyped = useCallback((v: string) => setConfirm((c) => ({ key, ticked: c.key === key ? c.ticked : false, typed: v })), [key]);
  return { state, friction: frictionOf(state), ticked, setTicked, typed, setTyped, satisfied: adviceSatisfied(state, ticked, typed), skip };
}
