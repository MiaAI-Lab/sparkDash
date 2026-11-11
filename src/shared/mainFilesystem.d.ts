export interface FilesystemView {
  mount: string;
  device?: string | null;
  totalBytes: number;
}

export function isSystemMount(mount: unknown): boolean;
export function mainFilesystem<T>(items: readonly T[] | null | undefined, view: (item: T) => FilesystemView): T | null;
export function statusView(f: { source: string; mount: string; totalBytes: number }): FilesystemView;
export function metricsView(d: { device: string; label: string; total: number }): FilesystemView;
