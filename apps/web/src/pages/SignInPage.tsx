import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, errorMessage, GOOGLE_SIGN_IN_URL } from "../api.ts";
import { Logo } from "../Logo.tsx";

/** What to say when Google sign-in sends the browser back here with ?error=… */
const REDIRECT_ERRORS: Record<string, string> = {
  google: "Signing in with Google didn't work. Try again, or use an email link.",
  sign_up_closed: "Sign-up isn't open yet. We've put you on the waitlist and will email you when it opens.",
};

export function SignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [options, setOptions] = useState({ google: false, signUpOpen: true });
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(() => REDIRECT_ERRORS[params.get("error") ?? ""] ?? null);

  useEffect(() => {
    // Someone already signed in goes straight to their Bots.
    api.me().then(
      () => navigate("/bots", { replace: true }),
      () => {},
    );
    api.signInOptions().then(setOptions, () => {});
  }, [navigate]);

  async function sendLink(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      await api.sendSignInLink(email);
      setSentTo(email.trim());
    } catch (caught) {
      setError(errorMessage(caught));
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
          {options.signUpOpen ? (
            <p>
              We sent a sign-in link to <strong>{sentTo}</strong>. It works once, for 15 minutes.
            </p>
          ) : (
            <p>
              We emailed <strong>{sentTo}</strong>. If you already have access, it's a sign-in link that works once,
              for 15 minutes. If not, you're on the waitlist, and we'll email you when sign-up opens.
            </p>
          )}
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
        <p className="muted">
          {options.signUpOpen
            ? "No password needed. If you're new, the same link signs you up."
            : "Sign-up opens at launch. If you already have access, sign in here; no password needed."}
        </p>
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
        {options.google && (
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
