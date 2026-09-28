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

/** Six-dot drag grip (reorder handles). */
export function GripIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)} fill="currentColor" stroke="none">
      <circle cx="9" cy="6" r="1.4" />
      <circle cx="15" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" />
      <circle cx="15" cy="18" r="1.4" />
    </svg>
  );
}

/** Chevron pointing left (navigate date ranges earlier). */
export function ChevronLeftIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/** Chevron pointing right (navigate date ranges later). */
export function ChevronRightIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M9 18l6-6-6-6" />
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

export function CpuIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
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

/** AI Proxy — route/globe style, distinct from NetworkIcon. */
export function ProxyIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** Bar chart — used for the AI Proxy statistics button. */
export function ChartIcon({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
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

/** Calendar — used for the model scheduler (running windows). */
export function CalendarIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

/** GitHub mark — used for a model's repo link. */
export function GithubIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 .5C5.73.5.5 5.74.5 12.02c0 5.1 3.29 9.42 7.86 10.95.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.68.8.56A11.53 11.53 0 0 0 23.5 12.02C23.5 5.74 18.27.5 12 .5Z" />
    </svg>
  );
}

/** Terminal/log lines — used to tail a running model's logs. */
export function LogsIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...baseProps(className)}>
      <polyline points="4 7 8 11 4 15" />
      <line x1="11" y1="15" x2="19" y2="15" />
      <line x1="11" y1="9" x2="15" y2="9" />
    </svg>
  );
}