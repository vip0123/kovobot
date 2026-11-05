import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiError, api, GOOGLE_SIGN_IN_URL } from "../api.ts";
import { Logo } from "./Logo.tsx";

export function SignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [google, setGoogle] = useState(false);
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") === "google" ? "Signing in with Google didn't work. Try again, or use an email link." : null,
  );

  useEffect(() => {
    // Someone already signed in goes straight to their Bots.
    api.me().then(
      () => navigate("/bots", { replace: true }),
      () => {},
    );
    api.signInOptions().then(
      (options) => setGoogle(options.google),
      () => {},
    );
  }, [navigate]);

  async function sendLink(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      await api.sendSignInLink(email);
      setSentTo(email.trim());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Something went wrong. Try again.");
    } finally {
      setSending(false);
    }
  }

  if (sentTo) {
    return (
      <main className="centered">
        <div className="card">
          <Logo />
          <h1>Check your email</h1>
          <p>
            We sent a sign-in link to <strong>{sentTo}</strong>. It works once, for 15 minutes.
          </p>
          <button type="button" className="button secondary" onClick={() => setSentTo(null)}>
            Use a different email
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="centered">
      <div className="card">
        <Logo />
        <h1>Sign in to Kovobot</h1>
        <p className="muted">No password needed. If you're new, the same link signs you up.</p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <form onSubmit={sendLink} className="stack">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <button type="submit" className="button primary" disabled={sending}>
            {sending ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
        {google && (
          <>
            <div className="divider">or</div>
            <a className="button secondary" href={GOOGLE_SIGN_IN_URL}>
              Sign in with Google
            </a>
          </>
        )}
      </div>
    </main>
  );
}
