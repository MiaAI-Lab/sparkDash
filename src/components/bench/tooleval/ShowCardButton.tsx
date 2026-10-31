import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImageIcon } from "../../ui/icons";
import { shareCardFileName, type ShareCardModel } from "../../SparkPage/benchShareCard";
import { CardPreview } from "../../SparkPage/CardPreview";
import { canCopyImages, copyPngToClipboard, renderShareCardPng } from "../../SparkPage/shareImage";

interface ShowCardButtonProps {
  /** Builds the card when the button is clicked, from whatever the page shows right then. */
  build: () => ShareCardModel;
  /** Which card this is — used for the download name. */
  kind: "tool-eval" | "tool-eval-compare";
  label?: string;
  /** Accessible name of the preview window, and the card image's alt text. */
  dialogLabel: string;
  imgAlt: string;
  title: string;
}

/**
 * "Show card": renders results as a share image (the same canvas card the decode,
 * prefill and quality benchmarks make) and opens it in a window where it can be
 * copied to the clipboard or saved as a PNG.
 */
export function ShowCardButton({ build, kind, label, dialogLabel, imgAlt, title }: ShowCardButtonProps) {
  const { t } = useTranslation("tooleval");
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [card, setCard] = useState<{ url: string; blob: Blob; model: ShareCardModel } | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "err">("idle");
  const timer = useRef<number | undefined>(undefined);
  const imageClipboard = canCopyImages();

  // The preview owns a blob URL; release it when it goes away.
  useEffect(
    () => () => {
      if (card) URL.revokeObjectURL(card.url);
    },
    [card]
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const close = useCallback(() => {
    setCard(null);
    setCopied("idle");
  }, []);

  // Escape closes the card, not whatever sits behind it.
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [card, close]);

  const show = async () => {
    if (state === "working") return;
    setState("working");
    const model = build();
    const blob = await renderShareCardPng(model);
    if (!blob) {
      setState("error");
      return;
    }
    setState("idle");
    setCard({ url: URL.createObjectURL(blob), blob, model });
  };

  const download = () => {
    if (!card) return;
    const link = document.createElement("a");
    link.href = card.url;
    link.download = shareCardFileName(card.model, kind);
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const copy = async () => {
    if (!card) return;
    try {
      await copyPngToClipboard(card.blob);
      setCopied("ok");
    } catch {
      setCopied("err");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied("idle"), 1800);
  };

  return (
    <>
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => void show()}
        disabled={state === "working"}
        title={title}
      >
        <ImageIcon className="h-3.5 w-3.5" />
        {state === "working" ? t("card.rendering") : state === "error" ? t("card.failed") : (label ?? t("card.show"))}
      </button>
      {card
        ? createPortal(
            <CardPreview
              url={card.url}
              label={dialogLabel}
              imgAlt={imgAlt}
              hint={
                imageClipboard ? (
                  <>{t("card.help")}</>
                ) : (
                  <>
                    {t("ui.copy.previewHintLead")} <strong>{t("ui.copy.previewHintStrong")}</strong>{t("ui.copy.previewHintBody")}
                  </>
                )
              }
              onClose={close}
              onDownload={download}
              onCopy={imageClipboard ? () => void copy() : undefined}
              copyLabel={copied === "ok" ? t("ui.copiedExclamation") : copied === "err" ? t("ui.actions.copyFailed") : t("card.copy")}
            />,
            document.body
          )
        : null}
    </>
  );
}
