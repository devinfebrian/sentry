import { useState } from "react";
import { Button } from "../components/ui/Button";
import { useAuth } from "./AuthProvider";

/**
 * Sign out, and say so when only the local half succeeded. Owning the warning here keeps
 * it beside the control that caused it, and spares every access-denied state from
 * threading the same piece of error state through its own branch.
 */
export function SignOutButton() {
  const { signOut } = useAuth();
  const [warning, setWarning] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setWarning(await signOut());
    setSigningOut(false);
  };

  return (
    <>
      <Button variant="secondary" type="button" disabled={signingOut} onClick={() => void handleSignOut()}>
        Sign out
      </Button>
      {warning && <p className="sign-out-warning" role="alert">{warning}</p>}
    </>
  );
}
