import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Link, Navigate, NavLink, useLocation, useNavigate } from "react-router";
import { ApiError, api, type Bot, type Customer, type ModelCatalog } from "./api.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { BookIcon, CloseIcon, MenuIcon, MoonIcon, PlusIcon, SignOutIcon, SunIcon } from "./Icons.tsx";
import { Logo } from "./Logo.tsx";
import { modelLabel } from "./ModelPicker.tsx";
import { currentTheme, pickTheme, type Theme } from "./theme.ts";

type Session =
  | { state: "loading" }
  | { state: "ready"; customer: Customer; bots: Bot[]; catalog: ModelCatalog }
  | { state: "signed-out" }
  | { state: "failed" };

/** What every signed-in page shares: the Customer, their Bots and the models offered here. */
export interface Shell {
  customer: Customer;
  bots: Bot[];
  catalog: ModelCatalog;
  /** Shows a created or changed Bot everywhere, the sidebar included. */
  saveBot: (bot: Bot) => void;
  forgetBot: (id: string) => void;
  openSidebar: () => void;
}

const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell works only on pages inside AppShell.");
  return shell;
}

/** Every signed-in page: checks the session, then shows the sidebar of Bots beside the page. */
export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [session, setSession] = useState<Session>({ state: "loading" });
  // On a phone the sidebar covers the page, so it's open only on the page it was opened on:
  // going anywhere closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const sidebarOpen = openOn === pathname;
  const setSidebarOpen = useCallback((open: boolean) => setOpenOn(open ? pathname : null), [pathname]);

  useEffect(() => {
    Promise.all([api.me(), api.bots(), api.models()]).then(
      ([{ customer }, { bots }, catalog]) => setSession({ state: "ready", customer, bots, catalog }),
      (error: unknown) =>
        setSession(error instanceof ApiError && error.status === 401 ? { state: "signed-out" } : { state: "failed" }),
    );
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setSidebarOpen(false);
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [sidebarOpen, setSidebarOpen]);

  const saveBot = useCallback((bot: Bot) => {
    setSession((current) => {
      if (current.state !== "ready") return current;
      const known = current.bots.some((candidate) => candidate.id === bot.id);
      const bots = known ? current.bots.map((candidate) => (candidate.id === bot.id ? bot : candidate)) : [...current.bots, bot];
      return { ...current, bots };
    });
  }, []);
  const forgetBot = useCallback((id: string) => {
    setSession((current) =>
      current.state === "ready" ? { ...current, bots: current.bots.filter((bot) => bot.id !== id) } : current,
    );
  }, []);
  const openSidebar = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);

  const shell = useMemo<Shell | null>(
    () =>
      session.state === "ready"
        ? { customer: session.customer, bots: session.bots, catalog: session.catalog, saveBot, forgetBot, openSidebar }
        : null,
    [session, saveBot, forgetBot, openSidebar],
  );

  async function signOut() {
    await api.signOut().catch(() => {});
    navigate("/sign-in", { replace: true });
  }

  if (session.state === "signed-out") return <Navigate to="/sign-in" replace />;
  if (session.state === "loading") {
    return (
      <main className="centered">
        <span className="loading">
          <span className="logo-mark pulse" aria-hidden="true" />
          Loading…
        </span>
      </main>
    );
  }
  if (session.state === "failed" || !shell) {
    return (
      <main className="centered">
        <p className="alert" role="alert">
          Couldn't reach Kovobot. Refresh the page to try again.
        </p>
      </main>
    );
  }

  return (
    <ShellContext.Provider value={shell}>
      <div className="app">
        <aside className={`sidebar${sidebarOpen ? " open" : ""}`} aria-label="Your Bots">
          <div className="sidebar-head">
            <Link to="/bots" className="logo-link">
              <Logo />
            </Link>
            <button
              type="button"
              className="icon-button sidebar-close"
              aria-label="Close the sidebar"
              onClick={() => setSidebarOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>
          <Link to="/bots/new" className="button primary sidebar-new">
            <PlusIcon size={18} />
            New Bot
          </Link>
          <nav className="sidebar-nav">
            <NavLink to="/skills" className="sidebar-link">
              <BookIcon size={18} />
              Skills
            </NavLink>
            <NavLink to="/bots" end className="sidebar-section">
              Bots
            </NavLink>
            {shell.bots.length === 0 ? (
              <p className="muted small sidebar-empty">Your Bots will be listed here.</p>
            ) : (
              <ul className="sidebar-bots">
                {shell.bots.map((bot) => (
                  <li key={bot.id}>
                    <NavLink to={`/bots/${bot.id}`} className="sidebar-bot">
                      <BotAvatar id={bot.id} name={bot.name} size="small" />
                      <span className="sidebar-bot-text">
                        <span className="sidebar-bot-name">{bot.name}</span>
                        <span className="sidebar-bot-model">{modelLabel(shell.catalog, bot.model)}</span>
                      </span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          <div className="sidebar-foot">
            <span className="sidebar-email" title={shell.customer.email}>
              {shell.customer.email}
            </span>
            <ThemeButton />
            <button type="button" className="icon-button" aria-label="Sign out" title="Sign out" onClick={signOut}>
              <SignOutIcon />
            </button>
          </div>
        </aside>
        {sidebarOpen && <div className="backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
        {children}
      </div>
    </ShellContext.Provider>
  );
}

function ThemeButton() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        pickTheme(next);
        setTheme(next);
      }}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/** The bar across the top of a page; on a phone it carries the button that opens the sidebar. */
export function PageHeader({ children }: { children: ReactNode }) {
  const { openSidebar } = useShell();
  return (
    <header className="page-header">
      <button type="button" className="icon-button sidebar-button" aria-label="Open the sidebar" onClick={openSidebar}>
        <MenuIcon />
      </button>
      {children}
    </header>
  );
}
