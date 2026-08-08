import { useState, type FormEvent } from "react";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { StatusBadge } from "../components/ui/StatusBadge";
import { formatDate } from "../lib/datetime";
import { INVALID_EMAIL_ERROR, normalizeMemberEmail } from "../services/sentinelMembers";
import type { SentinelMember, SentinelMemberRole, SentinelMemberService } from "../domain/types";
import { useWorkspaceMembers } from "./useWorkspaceMembers";

interface WorkspacePageProps {
  memberService?: Pick<SentinelMemberService, "list" | "invite" | "activate" | "setRole" | "rejectInvitation" | "setDisplayName"> | null;
  role?: SentinelMemberRole | null;
}

const roleLabels: Record<SentinelMemberRole, string> = { analyst: "Analyst", manager: "Manager" };
const statusLabels: Record<SentinelMember["status"], string> = { active: "Active", pending: "Pending" };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Try again to reload workspace members.";
}

export function WorkspacePage({ memberService, role }: WorkspacePageProps) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayNameInput] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteNotice, setInviteNotice] = useState("");
  const isManager = role === "manager";

  const { state, members, activeManagerCount, retry, mutate } = useWorkspaceMembers(memberService);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [confirmingRejectId, setConfirmingRejectId] = useState<string | null>(null);
  // Narrowed once, so the row actions need no non-null assertions. A null service
  // puts the hook in its error state, so the table never renders without one.
  const actions = isManager && memberService ? memberService : null;

  const runAction = async (userId: string, action: () => Promise<void>, successMessage: string) => {
    if (busyUserId || inviting) return;

    setInviteError("");
    setInviteNotice("");
    setBusyUserId(userId);
    const outcome = await mutate(action, successMessage, { refreshOnFailure: true });
    if (outcome.ok) setInviteNotice(outcome.message);
    else setInviteError(outcome.message);
    setBusyUserId(null);
    setConfirmingRejectId(null);
  };

  const handleInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!memberService || inviting) return;

    setInviteError("");
    setInviteNotice("");

    const normalized = normalizeMemberEmail(email);
    if (!normalized) {
      setInviteError(INVALID_EMAIL_ERROR);
      return;
    }

    setInviting(true);
    const outcome = await mutate(
      () => memberService.invite(normalized),
      `Invitation sent to ${normalized}. The member stays pending until they accept.`,
    );
    if (outcome.ok) setEmail("");
    if (outcome.ok) setInviteNotice(outcome.message);
    else setInviteError(outcome.message);
    setInviting(false);
  };

  const handleRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!memberService || renaming || busyUserId) return;

    setInviteError("");
    setInviteNotice("");

    const trimmed = displayName.trim();
    if (!trimmed) {
      setInviteError("Enter a display name.");
      return;
    }

    setRenaming(true);
    // The RPC resolves the caller itself, so this can only ever rename you.
    const outcome = await mutate(
      () => memberService.setDisplayName(trimmed),
      `Your display name is now ${trimmed}.`,
      { refreshOnFailure: true },
    );
    if (outcome.ok) setDisplayNameInput("");
    if (outcome.ok) setInviteNotice(outcome.message);
    else setInviteError(outcome.message);
    setRenaming(false);
  };

  return (
    <div className="workspace-settings-page">
      <header className="page-heading page-heading-simple">
        <div>
          <span className="eyebrow">Workspace / settings</span>
          <h1>Team and settings</h1>
          <p>Manage workspace members and review configuration boundaries.</p>
        </div>
      </header>

      {state.status === "loading" && <LoadingState label="Loading workspace members" />}

      {state.status === "error" && (
        <ErrorState
          title="Members unavailable"
          description={errorMessage(state.error)}
          action={<Button variant="secondary" onClick={retry}>Retry</Button>}
        />
      )}

      {state.status === "ready" && members.length === 0 && (
        <EmptyState
          title="No workspace members found"
          description="Your membership could not be listed. Reload the page or ask a workspace manager to confirm your access."
          action={<Button variant="secondary" onClick={retry}>Reload members</Button>}
        />
      )}

      {state.status === "ready" && members.length > 0 && (
        <section className="workspace-members" aria-labelledby="workspace-members-title">
          <div className="section-header-lined">
            <div>
              <span className="section-kicker">Access / membership</span>
              <h2 id="workspace-members-title">{"Workspace members"}</h2>
            </div>
          </div>
          <div className="table-scroll">
            <table className="data-table" aria-label={"Workspace members"}>
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Joined</th>
                  {actions && <th scope="col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.userId}>
                    <td>
                      {/* Display name is readable by every member; the address is not, so
                          it only ever appears as a manager-only second line. */}
                      <span className="member-identity">{member.displayName ?? member.email ?? member.userId}</span>
                      {member.isSelf && <span className="member-self"> (you)</span>}
                      {member.email && member.displayName && (
                        <span className="member-email">{member.email}</span>
                      )}
                    </td>
                    <td>{roleLabels[member.role]}</td>
                    <td>
                      <StatusBadge
                        status={member.status}
                        label={statusLabels[member.status]}
                        tone={member.status === "active" ? "confirm" : "warning"}
                      />
                    </td>
                    <td className="numeric">{formatDate(member.joinedAt)}</td>
                    {actions && (
                      <td className="member-actions">
                        {member.status === "pending" ? (
                          <>
                            <Button
                              variant="secondary"
                              type="button"
                              disabled={busyUserId === member.userId || inviting}
                              onClick={() => void runAction(
                                member.userId,
                                () => actions.activate(member.userId),
                                `${member.email ?? "Member"} activated.`,
                              )}
                            >
                              Activate
                            </Button>
                            {confirmingRejectId === member.userId ? (
                              <>
                                <Button
                                  variant="destructive"
                                  type="button"
                                  disabled={busyUserId === member.userId || inviting}
                                  onClick={() => void runAction(
                                    member.userId,
                                    () => actions.rejectInvitation(member.userId),
                                    `Invitation for ${member.email ?? "member"} rejected.`,
                                  )}
                                >
                                  Confirm reject
                                </Button>
                                <Button
                                  variant="quiet"
                                  type="button"
                                  disabled={busyUserId === member.userId || inviting}
                                  onClick={() => setConfirmingRejectId(null)}
                                >
                                  Cancel
                                </Button>
                              </>
                            ) : (
                              <Button
                                variant="quiet"
                                type="button"
                                disabled={busyUserId === member.userId || inviting}
                                onClick={() => setConfirmingRejectId(member.userId)}
                              >
                                Reject
                              </Button>
                            )}
                          </>
                        ) : member.role === "analyst" ? (
                          <Button
                            variant="secondary"
                            type="button"
                            disabled={busyUserId === member.userId || inviting}
                            onClick={() => void runAction(
                              member.userId,
                              () => actions.setRole(member.userId, "manager"),
                              `${member.email ?? "Member"} is now a manager.`,
                            )}
                          >
                            Make manager
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="secondary"
                              type="button"
                              disabled={busyUserId === member.userId || inviting || member.isSelf || activeManagerCount <= 1}
                              onClick={() => void runAction(
                                member.userId,
                                () => actions.setRole(member.userId, "analyst"),
                                `${member.email ?? "Member"} is now an analyst.`,
                              )}
                            >
                              Make analyst
                            </Button>
                            {member.isSelf ? (
                              <span className="member-action-hint">You cannot change your own role.</span>
                            ) : activeManagerCount <= 1 ? (
                              <span className="member-action-hint">Workspace must keep at least one manager.</span>
                            ) : null}
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Hold the invite controls back until the directory settles, and drop them entirely
          when there is no service to call, so the form is never a dead control. */}
      {/* Everyone can rename themselves; the seeded name is an email fragment, which is
          identifying but rarely what someone would choose to be called. */}
      {state.status === "ready" && memberService && (
        <section className="workspace-invite" aria-labelledby="workspace-display-name-title">
          <div className="section-header-lined">
            <div>
              <span className="section-kicker">Access / your profile</span>
              <h2 id="workspace-display-name-title">Your display name</h2>
            </div>
          </div>
          <p>This is how colleagues see you on cases you own. It never reveals your email address.</p>
          <form className="workspace-invite-form" noValidate onSubmit={(event) => void handleRename(event)}>
            <label htmlFor="member-display-name">Display name</label>
            <input
              id="member-display-name"
              name="displayName"
              type="text"
              maxLength={80}
              autoComplete="nickname"
              value={displayName}
              disabled={renaming}
              onChange={(event) => setDisplayNameInput(event.target.value)}
            />
            <Button variant="secondary" type="submit" disabled={renaming || busyUserId !== null}>Save name</Button>
          </form>
        </section>
      )}

      {state.status !== "loading" && isManager && memberService && (
        <section className="workspace-invite" aria-labelledby="workspace-invite-title">
          <div className="section-header-lined">
            <div>
              <span className="section-kicker">Access / invitations</span>
              <h2 id="workspace-invite-title">Invite an analyst</h2>
            </div>
          </div>
          <p>Invited analysts receive an email invitation and stay pending until they accept.</p>
          {/* noValidate: report invalid addresses through the alert region below rather
              than a native bubble, so the message is announced and matches the server rule. */}
          <form className="workspace-invite-form" noValidate onSubmit={(event) => void handleInvite(event)}>
            <label htmlFor="invite-member-email">Analyst email</label>
            <input
              id="invite-member-email"
              name="email"
              type="email"
              autoComplete="off"
              value={email}
              disabled={inviting || busyUserId !== null}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button variant="primary" type="submit" disabled={inviting || busyUserId !== null}>Send invitation</Button>
          </form>
        </section>
      )}

      {/* One place for every outcome on this page. These used to sit inside the
          manager-only invite section, which left an analyst renaming themselves with no
          feedback at all, and competing live regions are worse than one predictable one. */}
      {inviteError && <div className="import-error" role="alert">{inviteError}</div>}
      {inviteNotice && <div className="workspace-invite-notice" role="status" aria-live="polite">{inviteNotice}</div>}

      {state.status !== "loading" && !isManager && (
        <p className="workspace-invite-restricted">
          Only workspace managers can invite new members. Ask a manager to add analysts to this workspace.
        </p>
      )}
    </div>
  );
}
