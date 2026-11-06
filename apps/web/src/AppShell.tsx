import { type ReactNode, useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { ApiError, api, type Customer } from "./api.ts";
import { Logo } from "./Logo.tsx";

type Session = { state: "loading" } | { state: "ready"; customer: Customer } | { state: "signed-out" } | { state: "failed" };

/** Every signed-in page: checks the session, then shows the header and the page. */
export function AppShell({ children }: { children: (customer: Customer) => ReactNode }) {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session>({ state: "loading" });

  useEffect(() => {
    api.me().then(
      ({ customer }) => setSession({ state: "ready", customer }),
      (error: unknown) =>
        setSession(error instanceof ApiError && error.status === 401 ? { state: "signed-out" } : { state: "failed" }),
    );
  }, []);

  async function signOut() {
    await api.signOut().catch(() => {});
    navigate("/sign-in", { replace: true });
  }

  if (session.state === "signed-out") return <Navigate to="/sign-in" replace />;
  if (session.state === "loading") return <main className="centered muted">Loading…</main>;
  if (session.state === "failed") {
    return (
      <main className="centered">
        <p className="alert" role="alert">
          Couldn't reach Kovobot. Refresh the page to try again.
        </p>
      </main>
    );
  }

  return (
    <>
      <header className="topbar">
        <Link to="/bots" className="logo-link">
          <Logo />
        </Link>
        <div className="topbar-end">
          <span className="muted">{session.customer.email}</span>
          <button type="button" className="button secondary small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      {children(session.customer)}
    </>
  );
}
