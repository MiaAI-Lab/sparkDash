import { useEffect, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useOverlayClose } from "../../hooks/useOverlayClose";
import "../../styles/dialogs.css";

interface StorageDialogProps {
  open: boolean;
  /** Closing is blocked while an action runs. */
  busy: boolean;
  onClose: () => void;
  title: string;
  icon: ReactNode;
  tone?: "danger" | "neutral";
  children: ReactNode;
  footer: ReactNode;
}

/** The modal shell the Storage Manager's confirmations share: header, scrolling body, footer. */
export function StorageDialog({ open, busy, onClose, title, icon, tone = "danger", children, footer }: StorageDialogProps) {
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const overlayClose = useOverlayClose(onClose, !busy);

  useEffect(() => {
    if (!open || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  if (!mounted) return null;
  return createPortal(
    <div className={`modal-overlay${visible ? " is-open" : ""}`} {...overlayClose}>
      <div ref={trapRef} className="modal-sheet st-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={`modal-sheet__header${tone === "danger" ? " modal-sheet__header--danger" : ""}`}>
          {icon}
          <h2 className="modal-sheet__title" id={titleId}>
            {title}
          </h2>
        </div>
        <div className="modal-sheet__body modal-sheet__stack">{children}</div>
        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">{footer}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}
