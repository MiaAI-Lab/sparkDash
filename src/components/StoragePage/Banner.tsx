import type { ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, InfoIcon, XIcon } from "../ui/icons";

export type BannerTone = "ok" | "info" | "warn" | "error";

export interface BannerProps {
  tone: BannerTone;
  children: ReactNode;
  /** A button on the right, e.g. the way to fix what the banner says. */
  action?: ReactNode;
  onDismiss?: () => void;
}

/** A short message with an optional fix. `error` and `warn` are announced to screen readers at once. */
export function Banner({ tone, children, action, onDismiss }: BannerProps) {
  const Icon = tone === "ok" ? CheckIcon : tone === "info" ? InfoIcon : AlertTriangleIcon;
  return (
    <div className={`st-banner is-${tone}`} role={tone === "error" || tone === "warn" ? "alert" : "status"}>
      <Icon className="st-banner__icon h-4 w-4" />
      <div className="st-banner__text">{children}</div>
      {action ? <div className="st-banner__action">{action}</div> : null}
      {onDismiss ? (
        <button type="button" className="st-banner__x" onClick={onDismiss} aria-label="Dismiss">
          <XIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
