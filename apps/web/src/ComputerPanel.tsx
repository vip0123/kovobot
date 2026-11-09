import { useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import { api, type Bot, type Computer, type ComputerSize, errorMessage, type ModelCatalog } from "./api.ts";
import { CloseIcon } from "./Icons.tsx";

/** Driver models come only from the Model providers with a computer-use tool. */
const DRIVER_PROVIDERS = new Set(["openai", "anthropic", "google"]);

/** The idle times a Customer can pick before their Computer goes Asleep. */
const SLEEP_CHOICES = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 240, label: "4 hours" },
];

const STATE_LABELS: Record<Computer["state"], string> = {
  running: "Running",
  asleep: "Asleep",
  shut_down: "Shut down",
};

/** A Bot's Computer: create, start, shut down or delete it, and watch it live or take over. */
export function ComputerPanel({
  bot,
  catalog,
  computer,
  onChange,
  onBotChange,
  onClose,
}: {
  bot: Bot;
  catalog: ModelCatalog;
  computer: Computer | null;
  onChange: (computer: Computer | null) => void;
  onBotChange: (bot: Bot) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sizes, setSizes] = useState<ComputerSize[]>([]);
  const [size, setSize] = useState("small");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.computerSizes().then(({ sizes }) => setSizes(sizes), () => setSizes([]));
  }, []);

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

  const create = () => act(async () => (await api.createComputer(bot.id, size)).computer);
  const resize = (next: string) => act(async () => (await api.resizeComputer(bot.id, next)).computer);
  const setSleep = (minutes: number) => act(async () => (await api.setComputerSleep(bot.id, minutes)).computer);
  const drivers = catalog.models.filter((model) => DRIVER_PROVIDERS.has(model.provider) && model.available);
  async function setDriver(driverModel: string) {
    setError(null);
    try {
      onBotChange((await api.setDriverModel(bot.id, driverModel || null)).bot);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  const sizeLabel = (name: string) => {
    const spec = sizes.find((candidate) => candidate.size === name);
    return spec ? `${spec.name}: ${spec.vcpus} CPUs, ${spec.memoryGb} GB` : name;
  };
  const start = () => act(async () => (await api.startComputer(bot.id)).computer);
  const shutDown = () => act(async () => (await api.shutDownComputer(bot.id)).computer);
  const remove = () => act(async () => (await api.deleteComputer(bot.id), null));

  return (
    <section className="computer">
      <div className="computer-head">
        <div className="computer-title">
          <h2>Computer</h2>
          <span className={`badge ${computer ? computer.state : "none"}`}>
            {computer ? STATE_LABELS[computer.state] : "None yet"}
          </span>
        </div>
        <button type="button" className="icon-button" aria-label="Close the Computer panel" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <p className="muted small">
        {computer
          ? `A Linux desktop with Firefox, ${sizeLabel(computer.size)}.`
          : `A Linux desktop with Firefox that ${bot.name} can work on. You can watch it live and take over at any time.`}
      </p>

      {watching && computer?.state === "running" && <LiveView botId={bot.id} />}

      <div className="actions">
        {!computer && (
          <button type="button" className="button primary" disabled={busy} onClick={create}>
            {busy ? "Creating…" : "Create a Computer"}
          </button>
        )}
        {computer?.state === "running" && (
          <>
            <button type="button" className="button primary small" onClick={() => setWatching(!watching)}>
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
      </div>

      <div className="computer-settings">
        {sizes.length > 1 && (
          <div className="field">
            <label htmlFor="computer-size">Size</label>
            <select
              id="computer-size"
              value={computer ? computer.size : size}
              disabled={busy}
              onChange={(event) => (computer ? resize(event.target.value) : setSize(event.target.value))}
            >
              {sizes.map((option) => (
                <option key={option.size} value={option.size}>
                  {sizeLabel(option.size)}
                </option>
              ))}
            </select>
          </div>
        )}
        {computer && (
          <div className="field">
            <label htmlFor="computer-sleep">Goes Asleep after</label>
            <select
              id="computer-sleep"
              value={computer.sleepAfterMinutes}
              disabled={busy}
              onChange={(event) => setSleep(Number(event.target.value))}
            >
              {SLEEP_CHOICES.map((choice) => (
                <option key={choice.minutes} value={choice.minutes}>
                  {choice.label} with nothing going on
                </option>
              ))}
            </select>
          </div>
        )}
        {computer && (
          <div className="field">
            <label htmlFor="driver-model">{bot.name} uses it with</label>
            <select id="driver-model" value={bot.driverModel ?? ""} onChange={(event) => void setDriver(event.target.value)}>
              <option value="">No Driver model: {bot.name} can't use it yet</option>
              {drivers.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            {drivers.length === 0 && (
              <span className="muted small">A Driver model needs an OpenAI, Anthropic or Google key set up here.</span>
            )}
          </div>
        )}
      </div>

      {computer && (
        <div className="actions computer-delete">
          {confirmingDelete ? (
            <>
              <button type="button" className="button danger small" disabled={busy} onClick={remove}>
                Delete the Computer and its files
              </button>
              <button type="button" className="button secondary small" onClick={() => setConfirmingDelete(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="button ghost small danger-text" onClick={() => setConfirmingDelete(true)}>
              Delete the Computer…
            </button>
          )}
        </div>
      )}
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

  // A take-over is a lease: renewed while this view holds it, handed back when the view goes,
  // so a Bot never waits on a tab that was closed.
  useEffect(() => {
    if (!inControl) return;
    const renew = setInterval(() => void api.setComputerControl(botId, true).catch(() => {}), 20_000);
    return () => {
      clearInterval(renew);
      void api.setComputerControl(botId, false).catch(() => {});
    };
  }, [inControl, botId]);

  // Taking control tells the Bot to wait; handing back lets it carry on.
  async function toggleControl() {
    const rfb = viewer.current;
    if (!rfb) return;
    const taking = !inControl;
    try {
      await api.setComputerControl(botId, taking);
    } catch (caught) {
      setError(errorMessage(caught));
      return;
    }
    rfb.viewOnly = !taking;
    if (taking) rfb.focus();
    setInControl(taking);
  }

  return (
    <div className="live-view">
      <div ref={screen} className={`live-view-screen${inControl ? " in-control" : ""}`} />
      <div className="live-view-bar">
        <span className="muted small">
          {status === "connecting" && "Connecting…"}
          {status === "connected" &&
            (inControl ? "You have the mouse and keyboard; the Bot waits until you hand back." : "Watching live.")}
          {status === "disconnected" && (error ?? "The live view closed.")}
        </span>
        {status === "connected" && (
          <button type="button" className={`button small ${inControl ? "danger" : "secondary"}`} onClick={() => void toggleControl()}>
            {inControl ? "Hand back" : "Take over"}
          </button>
        )}
        {status === "disconnected" && (
          <button type="button" className="button secondary small" onClick={onReconnect}>
            Reconnect
          </button>
        )}
      </div>
    </div>
  );
}
