import { useTranslation } from "react-i18next";
import { localizedServerText } from "../../i18n/messages";

interface ErrorBannerProps {
  message: string | null;
  onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <div className="mb-3 flex items-start gap-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      <span className="min-w-0 flex-1">{localizedServerText(message)}</span>
      <button type="button" className="shrink-0 underline" onClick={onDismiss} aria-label={t("ui.error.dismissAria", "Dismiss error")}>
        {t("ui.error.dismiss", "Dismiss")}
      </button>
    </div>
  );
}
