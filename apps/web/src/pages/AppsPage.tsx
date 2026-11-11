import { type FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api, ApiError, type AppToolkit, type ConnectedApp, errorMessage } from "../api.ts";
import { AppShell, PageHeader } from "../AppShell.tsx";

/** The Customer's Connected apps: accounts on outside apps, through Composio, for their Bots to use. */
export function AppsPage() {
  return (
    <AppShell>
      <ConnectedApps />
    </AppShell>
  );
}

const STATES: Record<ConnectedApp["state"], { label: string; badge: string }> = {
  connected: { label: "Connected", badge: "running" },
  connecting: { label: "Signing in", badge: "asleep" },
  failed: { label: "Didn't connect", badge: "failed" },
};

/** What the page says on coming back from an app's sign-in. */
function outcome(params: URLSearchParams): string | null {
  const connected = params.get("connected");
  if (connected) return `${connected} is connected. Give it to a Bot on that Bot's Tools tab, under Customize.`;
  const failed = params.get("failed");
  return failed ? `Connecting ${failed} didn't work. Try again.` : null;
}

function ConnectedApps() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [notice] = useState(() => outcome(searchParams));
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [off, setOff] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [toolkits, setToolkits] = useState<AppToolkit[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.has("connected") || searchParams.has("failed")) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    api.apps().then(
      ({ apps }) => {
        setApps(apps);
        // The most used apps, until the Customer searches.
        api.appCatalog("").then(
          ({ toolkits }) => setToolkits(toolkits),
          (caught: unknown) => {
            setToolkits([]);
            setError(errorMessage(caught));
          },
        );
      },
      (caught: unknown) => {
        setApps([]);
        if (caught instanceof ApiError && caught.code === "apps_off") setOff(caught.message);
        else setError(errorMessage(caught));
      },
    );
  }, []);

  async function find(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      setToolkits((await api.appCatalog(search.trim())).toolkits);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function connect(toolkit: AppToolkit) {
    setBusy(toolkit.slug);
    setError(null);
    try {
      const { app, signInUrl } = await api.connectApp(toolkit.slug);
      // Off to the app's sign-in, hosted by Composio, which brings the Customer back here.
      if (signInUrl) {
        window.location.assign(signInUrl);
        return;
      }
      setApps((current) => (current?.some((each) => each.id === app.id) ? current : [...(current ?? []), app]));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function remove(app: ConnectedApp) {
    setBusy(app.id);
    setError(null);
    try {
      await api.removeApp(app.id);
      setApps((current) => current?.filter((each) => each.id !== app.id) ?? null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="main-page">
      <PageHeader>
        <h1 className="page-title">Connected apps</h1>
      </PageHeader>
      <div className="page-body">
        <div className="apps">
          <p className="muted skills-intro">
            Connect your accounts on apps such as Gmail, Slack or GitHub, then give each to the Bots you choose, on a Bot's Tools
            tab. Composio hosts each app's sign-in and keeps its tokens. A Bot reads at once; anything that sends, changes, deletes
            or pays asks you first.
          </p>
          {notice && <p className="notice small">{notice}</p>}
          {off && <p className="alert">{off}</p>}
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {apps === null ? (
            <p className="muted">Loading…</p>
          ) : (
            !off && (
              <>
                <h2 className="apps-heading">Yours</h2>
                {apps.length === 0 ? (
                  <p className="empty-list small">No Connected apps yet.</p>
                ) : (
                  <ul className="app-list">
                    {apps.map((app) => (
                      <li key={app.id} className="app-row">
                        <span className="app-initial" aria-hidden="true">
                          {app.name.slice(0, 1)}
                        </span>
                        <span className="app-row-text">
                          <span className="app-row-name">{app.name}</span>
                          {app.label && <span className="muted small">{app.label}</span>}
                        </span>
                        <span className={`badge ${STATES[app.state].badge}`}>{STATES[app.state].label}</span>
                        <button type="button" className="button ghost small danger-text" disabled={busy === app.id} onClick={() => void remove(app)}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <h2 className="apps-heading">Connect an app</h2>
                <form className="note-add" onSubmit={find}>
                  <label htmlFor="app-search" className="visually-hidden">
                    Find an app
                  </label>
                  <input id="app-search" type="search" placeholder="Gmail, Notion, GitHub…" value={search} onChange={(event) => setSearch(event.target.value)} />
                  <button type="submit" className="button secondary small">
                    Find
                  </button>
                </form>
                {toolkits === null ? (
                  <p className="muted small">Loading…</p>
                ) : toolkits.length === 0 ? (
                  !error && <p className="empty-list small">No app by that name.</p>
                ) : (
                  <ul className="app-list">
                    {toolkits.map((toolkit) => (
                      <li key={toolkit.slug} className="app-row">
                        <span className="app-initial" aria-hidden="true">
                          {toolkit.name.slice(0, 1)}
                        </span>
                        <span className="app-row-text">
                          <span className="app-row-name">{toolkit.name}</span>
                          <span className="muted small">
                            {toolkit.noAuth ? "No sign-in needed. " : ""}
                            {toolkit.description}
                          </span>
                        </span>
                        <button type="button" className="button secondary small" disabled={busy === toolkit.slug} onClick={() => void connect(toolkit)}>
                          {busy === toolkit.slug ? "Connecting…" : "Connect"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )
          )}
        </div>
      </div>
    </main>
  );
}
