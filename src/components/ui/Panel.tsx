import type { ReactNode, CSSProperties } from "react";

interface PanelProps {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  accent?: boolean;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * Shared panel primitive. Tool-grade surface: thin neutral border, subtle
 * elevation, an accent tick on the left, and a consistent uppercase title row
 * with an inline icon + optional actions on the right.
 */
export function Panel({
  title,
  icon,
  actions,
  accent = false,
  className = "",
  bodyClassName = "",
  style,
  children,
}: PanelProps) {
  return (
    <section
      className={`panel ${accent ? "panel-accent" : ""} ${className}`}
      style={{ padding: "var(--density-panel-pad)", ...style }}
    >
      <header
        className="flex items-center justify-between gap-2"
        style={{ marginBottom: "var(--density-panel-title-mb)" }}
      >
        <h3 className="panel-title">
          {icon}
          {title}
        </h3>
        {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}