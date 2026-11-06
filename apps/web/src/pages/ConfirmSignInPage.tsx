import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, errorMessage } from "../api.ts";
import { Logo } from "../Logo.tsx";

/**
 * Where an emailed sign-in link lands. Signing in takes a click, because mail
 * scanners open links on their own and would otherwise use up the one-time link.
 */
export function ConfirmSignInPage() {
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token"));
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    if (!token) return;
    setSigningIn(true);
    setError(null);
    try {
      await api.confirmSignInLink(token);
      navigate("/bots", { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
      setSigningIn(false);
    }
  }

  return (
    <main className="centered">
      <div className="card">
        <Logo />
        {token && !error ? (
          <>
            <h1>Sign in to Kovobot</h1>
            <p className="muted">You're one click away.</p>
            <button type="button" className="button primary" onClick={signIn} disabled={signingIn}>
              {signingIn ? "Signing in…" : "Sign in"}
            </button>
          </>
        ) : (
          <>
            <h1>This link doesn't work</h1>
            <p className="alert" role="alert">
              {error ?? "This sign-in link is incomplete. Ask for a new one."}
            </p>
            <Link className="button secondary" to="/sign-in">
              Get a new link
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
