import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { ApiError, api, type Customer } from "../api.ts";
import { Logo } from "../Logo.tsx";

type Load = { state: "loading" } | { state: "ready"; customer: Customer } | { state: "signed-out" } | { state: "failed" };

export function BotsPage() {
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    api.me().then(
      ({ customer }) => setLoad({ state: "ready", customer }),
      (error: unknown) =>
        setLoad(error instanceof ApiError && error.status === 401 ? { state: "signed-out" } : { state: "failed" }),
    );
  }, []);

  async function signOut() {
    await api.signOut().catch(() => {});
    navigate("/sign-in", { replace: true });
  }

  if (load.state === "signed-out") return <Navigate to="/sign-in" replace />;
  if (load.state === "loading") return <main className="centered muted">Loading…</main>;
  if (load.state === "failed") {
    return (
      <main className="centered">
        <p className="alert" role="alert">
          Couldn't load your Bots. Refresh the page to try again.
        </p>
      </main>
    );
  }

  return (
    <>
      <header className="topbar">
        <Logo />
        <div className="topbar-end">
          <span className="muted">{load.customer.email}</span>
          <button type="button" className="button secondary small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="page">
        <h1>Bots</h1>
        <section className="empty">
          <h2>No Bots yet</h2>
          <p className="muted">Your Bots will appear here.</p>
        </section>
      </main>
    </>
  );
}
