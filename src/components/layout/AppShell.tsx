import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { NavigationRail } from "./NavigationRail";
import { WorkspaceHeader } from "./WorkspaceHeader";

export function AppShell({ children }: { children: ReactNode }) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const location = useLocation();

  const closeNavigation = () => {
    setNavigationOpen(false);
    window.requestAnimationFrame(() => menuButtonRef.current?.focus());
  };

  useEffect(() => {
    if (!navigationOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeNavigation();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [navigationOpen]);

  useEffect(() => {
    window.requestAnimationFrame(() => mainRef.current?.focus());
  }, [location.pathname, location.search, location.hash]);

  return (
    <div className="app-shell">
      <aside className="desktop-navigation"><NavigationRail /></aside>
      <div className="app-content">
        <WorkspaceHeader ref={menuButtonRef} onOpenNavigation={() => setNavigationOpen(true)} />
        <main ref={mainRef} className="page-content" tabIndex={-1}>{children}</main>
      </div>
      {navigationOpen && <NavigationRail mobile onNavigate={closeNavigation} />}
    </div>
  );
}
