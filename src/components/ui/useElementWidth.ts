import { useEffect, useRef, useState } from "react";

/** Width of an element in px, kept current with a ResizeObserver. */
export function useElementWidth(initial = 640): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.max(200, Math.round(el.clientWidth) || initial));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [initial]);
  return [ref, w];
}
