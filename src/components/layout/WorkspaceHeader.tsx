import { forwardRef } from "react";
import { Button } from "../ui/Button";

interface WorkspaceHeaderProps {
  onOpenNavigation: () => void;
}

export const WorkspaceHeader = forwardRef<HTMLButtonElement, WorkspaceHeaderProps>(function WorkspaceHeader({ onOpenNavigation }, ref) {
  return (
    <header className="workspace-header">
      <Button ref={ref} className="mobile-menu-button" variant="quiet" aria-label="Open navigation" onClick={onOpenNavigation}>
        <span aria-hidden="true">+</span>
      </Button>
      <div className="workspace-title">
        <span className="workspace-mark" aria-hidden="true">F</span>
        <span>FinAI / workspace</span>
      </div>
      <div className="workspace-tools">
        <button className="header-tool" type="button">Search <kbd>/</kbd></button>
        <button className="header-tool header-tool-secondary" type="button">Help</button>
        <button className="profile-button" type="button" aria-label="Open Maya Chen profile">
          <span className="profile-initials" aria-hidden="true">MC</span>
          <span className="profile-name">Maya Chen</span>
        </button>
      </div>
    </header>
  );
});
