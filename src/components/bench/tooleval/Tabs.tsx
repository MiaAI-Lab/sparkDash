import type { ReactNode } from "react";
import { onRovingKeyDown } from "./a11y";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
}

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const panelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/**
 * A segmented tablist with roving tabindex and arrow/Home/End keys (WAI-ARIA tabs, automatic activation).
 * Pair each panel with `id={panelId(prefix, id)}`, `role="tabpanel"` and `aria-labelledby={tabId(prefix, id)}`.
 */
export function Tabs<T extends string>({ items, value, onChange, prefix, label }: { items: readonly TabItem<T>[]; value: T; onChange: (id: T) => void; prefix: string; label: string }) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          id={tabId(prefix, it.id)}
          aria-selected={value === it.id}
          aria-controls={panelId(prefix, it.id)}
          tabIndex={value === it.id ? 0 : -1}
          onClick={() => onChange(it.id)}
          onKeyDown={(e) => onRovingKeyDown(e, "tab", (i) => onChange(items[i].id), "horizontal")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
