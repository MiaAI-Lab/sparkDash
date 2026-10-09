/**
 * Compact inline icons (stroke-based, currentColor). No icon package.
 * Each accepts a className for sizing/color via Tailwind.
 */

interface IconProps {
  className?: string;
}

function baseProps(className?: string) {
  return {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className,
  };
}

export function ActivityIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

export function DiskIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 5v6c0 1.66-4 3-9 3s-9-1.34-9-3V5" />
      <path d="M21 11v6c0 1.66-4 3-9 3s-9-1.34-9-3v-6" />
    </svg>
  );
}

export function NetworkIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}

export function BotIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V4M9 2h6" />
      <circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none" />
      <path d="M2 14v2M22 14v2" />
    </svg>
  );
}

/** Chevron pointing down; rotate -90° when a section is collapsed. */
export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** External link (open ComfyUI). */
export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
    </svg>
  );
}

/** ComfyUI / image-workflow service. */
export function ComfyIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="11" r="2" />
      <path d="M3 16l5-4 3 2 4-5 6 7" />
    </svg>
  );
}

export function GearIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function SunIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

export function MoonIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/** Smaller sun with fewer rays — for light theme distinction. */
export function SunDimIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 22v2M2 12h2M22 12h2" />
    </svg>
  );
}

/** Moon with a tiny star — for OLED theme. */
export function MoonStarIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      <path d="M17 5l.5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z" />
    </svg>
  );
}

export function EditIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

export function PlusIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function GridIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

export function MemoryIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 12h4M14 12h4" />
    </svg>
  );
}

export function CpuIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </svg>
  );
}

export function BoltIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

export function RotateIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
    </svg>
  );
}

/** Power symbol — used for graceful shutdown. */
export function PowerOffIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

/** Circle-i — for short help / tooltips. */
export function InfoIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

/** Sun burst — used for Wake-on-LAN (distinct from PowerOffIcon). */
export function PowerOnIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="4.93" x2="7.05" y2="7.05" />
      <line x1="16.95" y1="16.95" x2="19.07" y2="19.07" />
      <line x1="4.93" y1="19.07" x2="7.05" y2="16.95" />
      <line x1="16.95" y1="7.05" x2="19.07" y2="4.93" />
    </svg>
  );
}

/** Comfortable density: three widely-spaced horizontal rows. */
export function ComfortableIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps()}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

/** Compact UI: three tightly-spaced horizontal rows. */
export function CompactIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps()}>
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="15" x2="20" y2="15" />
    </svg>
  );
}
/* ─── Redesign additions ──────────────────────────────── */

export function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function ChevronRightIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function XIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="m5 12 5 5 9-10" />
    </svg>
  );
}

export function AlertTriangleIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 3 2 20h20z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

export function FlaskIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3" />
    </svg>
  );
}

export function TerminalIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 10 3 2-3 2M12 15h5" />
    </svg>
  );
}

export function ImageIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m21 16-5-5-9 9" />
    </svg>
  );
}

export function ExpandIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}

export function ServerIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}

export function GripVerticalIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden className={className}>
      <circle cx="4" cy="3" r="1" />
      <circle cx="8" cy="3" r="1" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="8" cy="6" r="1" />
      <circle cx="4" cy="9" r="1" />
      <circle cx="8" cy="9" r="1" />
    </svg>
  );
}

export function TokensIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 2 3 7l9 5 9-5-9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  );
}

export function ListIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}

/** Speedometer: generation speed (Decode bench). */
export function GaugeIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M4.9 19a9 9 0 1 1 14.2 0" />
      <path d="m12 14 4-5" />
      <circle cx="12" cy="14" r="1" />
    </svg>
  );
}

/** Lines flowing into a bar: prompt processing (Prefill bench). */
export function PrefillIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M3 7h8M3 12h8M3 17h8" />
      <path d="m14 8 4 4-4 4" />
      <path d="M21 5v14" />
    </svg>
  );
}

/** Check inside a ring: answer quality (Quality bench). */
export function QualityIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.8 2.8L16 9.5" />
    </svg>
  );
}

/** Wrench: tool calling (Tool Eval bench). */
export function WrenchIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
    </svg>
  );
}

/** Window with a left panel: show / hide the sidebar. */
export function PanelLeftIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

/** Globe: a website link. */
export function GlobeIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.6 2.7 3.9 5.7 3.9 9s-1.3 6.3-3.9 9c-2.6-2.7-3.9-5.7-3.9-9S9.4 5.7 12 3z" />
    </svg>
  );
}

/** The X (formerly Twitter) mark. */
export function GithubIcon({ className = "" }: { className?: string }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}

export function XLogoIcon({ className = "" }: { className?: string }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M18.244 2H21.5l-7.1 8.12L22.8 22h-6.55l-5.13-6.7L5.2 22H1.94l7.6-8.68L1.5 2h6.72l4.64 6.13L18.244 2zm-1.14 18h1.8L7.3 3.9H5.37L17.1 20z" />
    </svg>
  );
}
