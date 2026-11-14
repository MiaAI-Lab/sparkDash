import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { StorageAdviceItem } from "../../api/types";
import { AlertTriangleIcon, CheckIcon, InfoIcon, RotateIcon } from "../ui/icons";
import { ADVICE_CONFIRM_PHRASE, adviceHeadline, effectiveLevel, flaggedItems, levelCounts, ownUnchecked, sharedUnchecked } from "./deleteAdvicePolicy";
import { baseName } from "./storageTree";
import type { DeleteAdvice } from "./useDeleteAdvice";

interface DeleteAdviceBlockProps {
  advice: DeleteAdvice;
  sparkName: string;
  /** Several items (the bulk dialog): a summary, then each item with something to say. */
  many: boolean;
  /** A delete is running: nothing here can change. */
  disabled: boolean;
  /** Enter in the typed phrase: try to delete. */
  onSubmit: () => void;
}

function levelLabel(t: ReturnType<typeof useTranslation>["t"], level: "high" | "review" | "low" | "note") {
  switch (level) {
    case "high": return t("advice.high");
    case "review": return t("advice.review");
    case "low": return t("advice.low");
    case "note": return t("advice.note");
  }
}

/** One item's findings: the serious ones first, then what was not checked (less what `shared` already said), then notes. */
function ReasonList({ item, shared = [] }: { item: StorageAdviceItem; shared?: StorageAdviceItem["unchecked"] }) {
  const { t } = useTranslation("storage");
  return (
    <ul className="st-advice__list">
      {item.reasons
        .filter((r) => r.level !== "note")
        .map((r, k) => (
          <li key={`r${k}`} className={`is-${r.level}`}>
            <span className="st-advice__mark">{levelLabel(t, r.level)}</span>
            <span>{r.text}</span>
          </li>
        ))}
      {ownUnchecked(item, shared).map((u, k) => (
        <li key={`u${k}`} className="is-unchecked">
          <span className="st-advice__mark">{t("advice.notChecked")}</span>
          <span>{u.text}</span>
        </li>
      ))}
      {item.reasons
        .filter((r) => r.level === "note")
        .map((r, k) => (
          <li key={`n${k}`} className="is-note">
            <span className="st-advice__mark">{t("advice.note")}</span>
            <span>{r.text}</span>
          </li>
        ))}
    </ul>
  );
}

/**
 * The delete check inside a delete dialog: what the Spark and the dashboard found about the items, and what that asks
 * of the person (nothing, a tick, or a typed phrase). Always the same size: the details scroll inside a fixed area and
 * every confirmation is laid out in one place, only the one that applies shown, so nothing moves when the answer
 * arrives. The level is written out, never shown by colour alone.
 */
export function DeleteAdviceBlock({ advice, sparkName, many, disabled, onSubmit }: DeleteAdviceBlockProps) {
  const { t } = useTranslation("storage");
  const id = useId();
  const { state, friction } = advice;
  const level = effectiveLevel(state);
  const tone = level ?? "wait";
  const badge = state.status === "loading" ? t("advice.checking") : state.status === "ready" ? levelLabel(t, state.advice.level) : t("advice.review");
  const them = many ? "them" : "it";
  const icon =
    state.status === "loading" ? (
      <RotateIcon className="st-advice__spin h-3 w-3" />
    ) : level === "high" ? (
      <AlertTriangleIcon className="h-3 w-3" />
    ) : level === "review" ? (
      <InfoIcon className="h-3 w-3" />
    ) : (
      <CheckIcon className="h-3 w-3" />
    );

  let body;
  if (state.status === "loading") {
    body = (
      <>
        <div className="st-advice__skeleton" aria-hidden>
          <i />
          <i />
          <i />
        </div>
        <p className="st-advice__muted">
          {t("advice.looking", { sparkName, target: them })}
        </p>
      </>
    );
  } else if (state.status === "failed" || state.status === "skipped") {
    body = (
      <ul className="st-advice__list">
        <li className="is-unchecked">
          <span className="st-advice__mark">{t("advice.notChecked")}</span>
          <span>
            {state.status === "failed" ? t("advice.checkFailed", { message: state.message.replace(/\.$/, "") }) : t("advice.skip")} {t("advice.proceedCarefully", { target: many ? "these items" : "this item" })}
          </span>
        </li>
      </ul>
    );
  } else {
    const { items, covered } = state.advice;
    const checked = t("advice.checked", { sparkName, target: them });
    if (!many || items.length <= 1) {
      const item = items[0];
      body = (
        <>
          {state.advice.level === "low" && state.advice.complete ? <p className="st-advice__muted">{checked}</p> : null}
          {item ? <ReasonList item={item} /> : null}
        </>
      );
    } else {
      const counts = levelCounts(items);
      const shared = sharedUnchecked(items);
      const flagged = flaggedItems(items, shared);
      const quiet = items.length - flagged.length;
      body = (
        <>
          <p className="st-advice__sum">
            {(["high", "review", "low"] as const)
              .filter((l) => counts[l] > 0)
              .map((l) => `${counts[l]} ${levelLabel(t, l)}`)
              .join(" · ")}
            {covered.length > 0 ? ` · ${covered.length} inside selected folders, checked with them` : ""}
          </p>
          {state.advice.level === "low" && state.advice.complete ? <p className="st-advice__muted">{checked}</p> : null}
          {shared.length > 0 ? (
            <ul className="st-advice__list st-advice__shared">
              {shared.map((u, k) => (
                <li key={k} className="is-unchecked">
                  <span className="st-advice__mark">{t("advice.notChecked")}</span>
                  <span>{t("advice.forEvery", { text: u.text })}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <ul className="st-advice__items" aria-label={t("advice.checkItems")}>
            {flagged.map((it) => (
              <li key={it.path} className={`st-advice__item is-${it.level}`}>
                <div className="st-advice__itemhead">
                  <b title={it.path}>{baseName(it.path)}</b>
                  <span className="st-advice__itemlevel">{levelLabel(t, it.level)}</span>
                </div>
                <ReasonList item={it} shared={shared} />
              </li>
            ))}
          </ul>
          {quiet > 0 && (flagged.length > 0 || shared.length > 0) ? (
            <p className="st-advice__muted">
              {t("advice.quiet", { count: quiet, other: flagged.length > 0 ? "other " : "", else: shared.length > 0 ? "else " : "" })}
            </p>
          ) : null}
        </>
      );
    }
  }

  return (
    <section className={`st-advice is-${tone}${many ? " st-advice--bulk" : ""}`} aria-labelledby={`${id}-title`} aria-busy={state.status === "loading"}>
      <div className="st-advice__head">
        <span className="st-advice__badge" aria-hidden>
          {icon}
          {badge}
        </span>
        <p id={`${id}-title`} className="st-advice__title" role="status" aria-live="polite">
          <span className="sr-only">{t("advice.deleteCheck", { badge })} </span>
          {adviceHeadline(state)}
        </p>
      </div>
      <div className="st-advice__body" tabIndex={0} role="group" aria-label={t("advice.whatFound")}>
        {body}
      </div>
      {/* Every confirmation laid out in one place, only the one that applies shown: the dialog keeps its size. */}
      <div className="st-swap st-advice__confirm">
        <div className={`st-advice__wait${friction === "wait" ? "" : " is-off"}`} inert={friction !== "wait"} aria-hidden={friction !== "wait"}>
          <span>{t("advice.wait")}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={advice.skip} disabled={disabled || friction !== "wait"}>
            Don&rsquo;t wait
          </button>
        </div>
        <p className={`st-advice__none${friction === "none" ? "" : " is-off"}`} aria-hidden={friction !== "none"}>
          {t("advice.nothingMore")}
        </p>
        <label className={`check-row st-advice__tick${friction === "tick" ? "" : " is-off"}`} inert={friction !== "tick"} aria-hidden={friction !== "tick"}>
          <input type="checkbox" checked={advice.ticked} disabled={disabled || friction !== "tick"} onChange={(e) => advice.setTicked(e.target.checked)} />
          <span>{t("advice.readStillDelete", { target: them })}</span>
        </label>
        <div className={`field st-advice__typed${friction === "typed" ? "" : " is-off"}`} inert={friction !== "typed"} aria-hidden={friction !== "typed"}>
          {/* Not a <label for>: the phrase is meant to be selected and copied (see the name field). */}
          <div id={`${id}-typed`} className="st-field-label">
            Type <b className="mono st-selectable">{ADVICE_CONFIRM_PHRASE}</b> to delete {them} all the same
          </div>
          <input
            aria-labelledby={`${id}-typed`}
            type="text"
            className="field-input--mono"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={advice.typed}
            disabled={disabled || friction !== "typed"}
            placeholder={ADVICE_CONFIRM_PHRASE}
            onChange={(e) => advice.setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
        </div>
      </div>
    </section>
  );
}
