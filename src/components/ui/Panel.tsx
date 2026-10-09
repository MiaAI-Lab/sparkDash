import type { ReactNode, CSSProperties } from "react";

interface PanelProps {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  accent?: boolean;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  /** Tooltip on the title, for readings that are easy to misread. */
  hint?: string;
  children: ReactNode;
}

/**
 * Shared panel primitive. Flat surface with a thin neutral border and a
 * consistent title row: small muted icon, sentence-case title, and optional
 * actions on the right (wrapping under the title on narrow screens). `accent`
 * is kept for API compatibility; the redesign no longer draws the left tick.
 */
export function Panel({
  title,
  icon,
  actions,
  accent = false,
  className = "",
  bodyClassName = "",
  style,
  hint,
  children,
}: PanelProps) {
  return (
    <section
      className={`panel ${accent ? "panel-accent" : ""} ${className}`}
      style={{ padding: "var(--density-panel-pad)", ...style }}
    >
      <header
        className="panel-head flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
        style={{ marginBottom: "var(--density-panel-title-mb)" }}
      >
        <h3 className="panel-title flex min-w-0 items-center gap-2" title={hint}>
          {icon}
          {title}
        </h3>
        {actions ? <div className="panel-actions flex min-w-0 flex-wrap items-center gap-1.5">{actions}</div> : null}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}