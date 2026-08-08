import { forwardRef } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../ui/Button";

interface WorkspaceHeaderProps {
  onOpenNavigation: () => void;
}

/**
 * The signed-in user's own address is always readable from the session, so naming them
 * here needs no membership lookup and no column grant.
 */
function identityFrom(email: string | undefined) {
  const local = email?.split("@")[0]?.trim();
  if (!local) return { name: "Signed in", initials: "--" };

  const words = local.split(/[._-]+/).filter(Boolean);
  const initials = (words.length > 1 ? `${words[0][0]}${words[1][0]}` : local.slice(0, 2)).toUpperCase();
  return { name: local, initials };
}

export const WorkspaceHeader = forwardRef<HTMLButtonElement, WorkspaceHeaderProps>(function WorkspaceHeader({ onOpenNavigation }, ref) {
  const { user } = useAuth();
  const { name, initials } = identityFrom(user?.email);

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
        {/* Not a button: there is no profile screen to open, and a control that looks
            interactive and does nothing is the same class of untruth as the name was. */}
        <span className="profile-button" aria-label={`Signed in as ${user?.email ?? name}`}>
          <span className="profile-initials" aria-hidden="true">{initials}</span>
          <span className="profile-name">{name}</span>
        </span>
      </div>
    </header>
  );
});
