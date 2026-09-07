import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const roots = new Set<Root>();

export function render(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => root.render(ui));
  return { container, root };
}

export async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

export function cleanupRenders() {
  for (const root of roots) act(() => root.unmount());
  roots.clear();
}
