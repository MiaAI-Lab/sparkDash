import type { ReactNode } from "react";

export type TagTone = "neutral" | "good" | "warn" | "bad" | "acc" | "info";

const TONE_CLASS: Record<TagTone, string> = {
  neutral: "",
  good: "tag--good",
  warn: "tag--warn",
  bad: "tag--bad",
  acc: "tag--acc",
  info: "tag--info",
};

/** Small status / role / info pill. Tone encodes meaning (good / warn / bad), `acc` is the brand accent. */
export function Tag({
  tone = "neutral",
  title,
  className = "",
  children,
}: {
  tone?: TagTone;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={`tag ${TONE_CLASS[tone]} ${className}`} title={title}>
      {children}
    </span>
  );
}
