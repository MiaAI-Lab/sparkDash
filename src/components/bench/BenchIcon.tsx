import { FlaskIcon, GaugeIcon, PrefillIcon, QualityIcon, WrenchIcon } from "../ui/icons";

const ICONS: Record<string, typeof FlaskIcon> = {
  decode: GaugeIcon,
  prefill: PrefillIcon,
  quality: QualityIcon,
  "tool-eval": WrenchIcon,
};

/** One distinct icon per benchmark page (flask for anything without its own). */
export function BenchIcon({ id, className }: { id: string; className?: string }) {
  const Icon = ICONS[id] ?? FlaskIcon;
  return <Icon className={className} />;
}
