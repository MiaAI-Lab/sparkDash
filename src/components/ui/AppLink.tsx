import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";

interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "onClick" | "href"> {
  href: string;
  /** In-app navigation for a plain left-click. Modified clicks and the context menu keep normal link behaviour. */
  onNavigate: () => void;
  children: ReactNode;
}

/** A real link (right-click → open in new tab, copy address…) that navigates without a page reload. */
export function AppLink({ href, onNavigate, children, ...rest }: AppLinkProps) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onNavigate();
      }}
    >
      {children}
    </a>
  );
}
