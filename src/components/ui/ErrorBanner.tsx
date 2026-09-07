interface ErrorBannerProps {
  message: string | null;
  onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  if (!message) return null;
  return (
    <div className="mb-3 flex items-start gap-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      <span className="min-w-0 flex-1">{message}</span>
      <button type="button" className="shrink-0 underline" onClick={onDismiss} aria-label="Dismiss error">
        Dismiss
      </button>
    </div>
  );
}
