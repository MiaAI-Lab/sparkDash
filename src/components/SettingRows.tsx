/** The Settings dialog's row layout, shared with dialogs opened from it (Alerts). */

export function SettingRow({
  title,
  help,
  htmlFor,
  stack = false,
  children,
}: {
  title: string;
  help?: React.ReactNode;
  htmlFor?: string;
  /** Text above, control below (for controls that need room or show messages). */
  stack?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`set-row${stack ? " set-row--stack" : ""}`}>
      <div className="set-row__text">
        {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <span className="set-row__title">{title}</span>}
        {help && <small>{help}</small>}
      </div>
      <div className="set-row__control">{children}</div>
    </div>
  );
}

export function ToggleRow({
  title,
  help,
  checked,
  onChange,
  disabled = false,
  label,
  children,
}: {
  title: string;
  help?: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name for the switch when the title alone is ambiguous. */
  label?: string;
  /** Extra controls next to the switch (e.g. a duration field). */
  children?: React.ReactNode;
}) {
  return (
    <SettingRow title={title} help={help}>
      {children}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label ?? title}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50${
          checked ? " is-on" : ""
        }`}
      >
        <span
          className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </SettingRow>
  );
}
