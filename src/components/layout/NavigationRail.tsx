import { useLocation, useNavigate } from "react-router-dom";
import { navigation } from "../../app/routes";

interface NavigationRailProps {
  mobile?: boolean;
  onNavigate?: () => void;
}

const groupLabels = {
  workspace: "Workspace",
  operations: "Operations",
  settings: "Workspace settings",
} as const;

export function NavigationRail({ mobile = false, onNavigate }: NavigationRailProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const groups = ["workspace", "operations", "settings"] as const;

  const handleNavigate = (path: string) => {
    navigate(path);
    onNavigate?.();
  };

  const content = (
    <nav className={`navigation-rail ${mobile ? "navigation-rail-mobile" : ""}`} aria-label={mobile ? "Workspace navigation" : "Main navigation"}>
      <div className="rail-brand"><span className="rail-brand-mark" aria-hidden="true">F</span><span>Finance intelligence</span></div>
      {groups.map((group) => (
        <div className="rail-group" key={group}>
          <span className="rail-group-label">{groupLabels[group]}</span>
          <div className="rail-links">
            {navigation.filter((item) => item.group === group).map((item) => {
              const active = location.pathname === item.path || (item.path !== "/" && location.pathname.startsWith(item.path));
              return (
                <button
                  className={`rail-link ${active ? "rail-link-active" : ""}`}
                  key={item.label}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => handleNavigate(item.path)}
                >
                  <span className="rail-link-index" aria-hidden="true">{String(navigation.indexOf(item) + 1).padStart(2, "0")}</span>
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="rail-footnote">
        <span className="status-dot status-dot-confirm" aria-hidden="true" />
        <span>All systems operational</span>
      </div>
    </nav>
  );

  if (!mobile) return content;

  return (
    <div className="navigation-drawer" role="dialog" aria-modal="true" aria-label="Workspace navigation">
      <button className="drawer-backdrop" aria-label="Close navigation overlay" type="button" onClick={onNavigate} />
      <div className="drawer-panel">
        <button className="drawer-close" aria-label="Close navigation" type="button" onClick={onNavigate}>Close</button>
        {content}
      </div>
    </div>
  );
}
