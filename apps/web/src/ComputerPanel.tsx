import { useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import { api, type Bot, type Computer, errorMessage } from "./api.ts";

const STATE_LABELS: Record<Computer["state"], string> = {
  running: "Running",
  asleep: "Asleep",
  shut_down: "Shut down",
};

/** A Bot's Computer: create, start, shut down or delete it, and watch it live or take over. */
export function ComputerPanel({
  bot,
  computer,
  onChange,
}: {
  bot: Bot;
  computer: Computer | null;
  onChange: (computer: Computer | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<Computer | null>) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      onChange(next);
      if (next?.state !== "running") setWatching(false);
      setConfirmingDelete(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const create = () => act(async () => (await api.createComputer(bot.id)).computer);
  const start = () => act(async () => (await api.startComputer(bot.id)).computer);
  const shutDown = () => act(async () => (await api.shutDownComputer(bot.id)).computer);
  const remove = () => act(async () => (await api.deleteComputer(bot.id), null));

  return (
    <section className="computer" aria-label={`${bot.name}'s Computer`}>
      <div className="computer-head">
        <h2>Computer</h2>
        <span className="muted small">
          {computer ? STATE_LABELS[computer.state] : `None yet: a Linux desktop ${bot.name} can work on.`}
        </span>
        <div className="actions">
          {!computer && (
            <button type="button" className="button primary small" disabled={busy} onClick={create}>
              {busy ? "Creating…" : "Create a Computer"}
            </button>
          )}
          {computer?.state === "running" && (
            <>
              <button type="button" className="button secondary small" onClick={() => setWatching(!watching)}>
                {watching ? "Hide live view" : "Watch live"}
              </button>
              <button type="button" className="button secondary small" disabled={busy} onClick={shutDown}>
                Shut down
              </button>
            </>
          )}
          {computer && computer.state !== "running" && (
            <button type="button" className="button primary small" disabled={busy} onClick={start}>
              {busy ? "Starting…" : "Start"}
            </button>
          )}
          {computer &&
            (confirmingDelete ? (
              <>
                <button type="button" className="button danger small" disabled={busy} onClick={remove}>
                  Delete the Computer and its files
                </button>
                <button type="button" className="button secondary small" onClick={() => setConfirmingDelete(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" className="button secondary small" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            ))}
        </div>
      </div>
      {watching && computer?.state === "running" && <LiveView botId={bot.id} />}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** The live view, with a way to connect again after it drops. */
function LiveView({ botId }: { botId: string }) {
  const [attempt, setAttempt] = useState(0);
  return <Screen key={attempt} botId={botId} onReconnect={() => setAttempt(attempt + 1)} />;
}

/**
 * One connection to the Computer's screen. It starts as watch-only, so a stray click
 * can't disturb the Computer; Take over hands the Customer the mouse and keyboard.
 */
function Screen({ botId, onReconnect }: { botId: string; onReconnect: () => void }) {
  const screen = useRef<HTMLDivElement>(null);
  const viewer = useRef<RFB | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [inControl, setInControl] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The VNC viewer loads only when someone watches, so the rest of the app stays small.
    Promise.all([api.liveView(botId), import("@novnc/novnc")]).then(
      ([{ url }, { default: RFB }]) => {
        if (cancelled || !screen.current) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const rfb = new RFB(screen.current, `${protocol}//${window.location.host}${url}`);
        rfb.viewOnly = true;
        rfb.scaleViewport = true;
        rfb.addEventListener("connect", () => setStatus("connected"));
        rfb.addEventListener("disconnect", () => setStatus("disconnected"));
        viewer.current = rfb;
      },
      (caught: unknown) => {
        if (cancelled) return;
        setError(errorMessage(caught));
        setStatus("disconnected");
      },
    );
    return () => {
      cancelled = true;
      viewer.current?.disconnect();
      viewer.current = null;
    };
  }, [botId]);

  function toggleControl() {
    const rfb = viewer.current;
    if (!rfb) return;
    rfb.viewOnly = inControl;
    if (!inControl) rfb.focus();
    setInControl(!inControl);
  }

  return (
    <div className="live-view">
      <div className="live-view-bar">
        <span className="muted small">
          {status === "connecting" && "Connecting…"}
          {status === "connected" && (inControl ? "You're in control of the mouse and keyboard." : "Watching live.")}
          {status === "disconnected" && (error ?? "The live view closed.")}
        </span>
        {status === "connected" && (
          <button type="button" className="button secondary small" onClick={toggleControl}>
            {inControl ? "Hand back" : "Take over"}
          </button>
        )}
        {status === "disconnected" && (
          <button type="button" className="button secondary small" onClick={onReconnect}>
            Reconnect
          </button>
        )}
      </div>
      <div ref={screen} className={`live-view-screen${inControl ? " in-control" : ""}`} />
    </div>
  );
}
