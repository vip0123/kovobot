import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, type Bot, type Computer, errorMessage, type Message, type ModelCatalog } from "../api.ts";
import { AppShell, PageHeader, useShell } from "../AppShell.tsx";
import { BotAvatar } from "../BotAvatar.tsx";
import { ComputerPanel } from "../ComputerPanel.tsx";
import { Conversation } from "../Conversation.tsx";
import { ChevronDownIcon, ComputerIcon } from "../Icons.tsx";
import { Menu } from "../Menu.tsx";
import { canUse, ModelPicker, modelLabel } from "../ModelPicker.tsx";


export function BotPage() {
  return (
    <AppShell>
      <BotRoute />
    </AppShell>
  );
}

// A fresh page for each Bot, so nothing typed or loaded for one shows on another.
function BotRoute() {
  const { id = "" } = useParams();
  return <BotChat key={id} id={id} />;
}

/** undefined while loading, "off" where no Computer service is set up, null for none yet. */
type ComputerState = Computer | null | "off" | undefined;

const COMPUTER_STATES: Record<Computer["state"], string> = {
  running: "Running",
  asleep: "Asleep",
  shut_down: "Shut down",
};

/** One Bot: its Conversation on the web Channel, and its Computer beside it. */
function BotChat({ id }: { id: string }) {
  const { bots, catalog, saveBot } = useShell();
  const bot = bots.find((candidate) => candidate.id === id);
  const exists = bot !== undefined;
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [computer, setComputer] = useState<ComputerState>(undefined);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    if (!exists) return;
    api.messages(id).then(
      ({ messages }) => setMessages(messages),
      (caught: unknown) => {
        setMessages([]);
        setLoadError(errorMessage(caught));
      },
    );
    api.computer(id).then(
      ({ computer }) => setComputer(computer),
      (caught: unknown) => setComputer(caught instanceof ApiError && caught.code === "computers_off" ? "off" : null),
    );
  }, [id, exists]);

  if (!bot) {
    return (
      <main className="main-page">
        <PageHeader>
          <h1 className="page-title">Bot not found</h1>
        </PageHeader>
        <div className="page-body">
          <p className="alert" role="alert">
            There's no such Bot.
          </p>
          <p>
            <Link to="/bots">Back to your Bots</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="main-page bot-page">
      <BotHeader
        bot={bot}
        catalog={catalog}
        computer={computer}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
        onChange={saveBot}
      />
      <div className="bot-body">
        <Conversation
          bot={bot}
          catalog={catalog}
          messages={messages}
          loadError={loadError}
          onMessages={(update) => setMessages((current) => update(current ?? []))}
          canUseComputer={Boolean(computer && computer !== "off" && bot.driverModel)}
        />
        {panelOpen && computer !== undefined && computer !== "off" && (
          <aside className="computer-drawer" aria-label={`${bot.name}'s Computer`}>
            <ComputerPanel
              bot={bot}
              catalog={catalog}
              computer={computer}
              onChange={setComputer}
              onBotChange={saveBot}
              onClose={() => setPanelOpen(false)}
            />
          </aside>
        )}
      </div>
    </main>
  );
}

function BotHeader({
  bot,
  catalog,
  computer,
  panelOpen,
  onTogglePanel,
  onChange,
}: {
  bot: Bot;
  catalog: ModelCatalog;
  computer: ComputerState;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onChange: (bot: Bot) => void;
}) {
  const navigate = useNavigate();
  const { forgetBot } = useShell();
  const [mode, setMode] = useState<"idle" | "renaming" | "switching" | "deleting">("idle");
  const [name, setName] = useState(bot.name);
  const [model, setModel] = useState(bot.model);
  const [error, setError] = useState<string | null>(null);
  const hasComputer = Boolean(computer && computer !== "off");

  async function rename(event: FormEvent) {
    event.preventDefault();
    try {
      onChange((await api.renameBot(bot.id, name)).bot);
      setMode("idle");
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function switchModel(event: FormEvent) {
    event.preventDefault();
    try {
      onChange((await api.switchModel(bot.id, model)).bot);
      setMode("idle");
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function remove() {
    try {
      await api.deleteBot(bot.id);
      forgetBot(bot.id);
      navigate("/bots", { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  function start(next: "renaming" | "switching" | "deleting") {
    setName(bot.name);
    setModel(bot.model);
    setError(null);
    setMode(next);
  }

  return (
    <>
      <PageHeader>
        <div className="bot-heading">
          <BotAvatar id={bot.id} name={bot.name} size="small" />
          {mode === "renaming" ? (
            <form className="inline-form" onSubmit={rename}>
              <label htmlFor="rename" className="visually-hidden">
                Name
              </label>
              <input id="rename" required maxLength={80} autoFocus value={name} onChange={(event) => setName(event.target.value)} />
              <button type="submit" className="button primary small">
                Save
              </button>
              <button type="button" className="button secondary small" onClick={() => setMode("idle")}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <h1 className="page-title">{bot.name}</h1>
              <button
                type="button"
                className="model-chip"
                aria-expanded={mode === "switching"}
                onClick={() => (mode === "switching" ? setMode("idle") : start("switching"))}
              >
                <span className="visually-hidden">Change the model, now </span>
                <span className="model-chip-name">{modelLabel(catalog, bot.model)}</span>
                <ChevronDownIcon size={16} />
              </button>
            </>
          )}
        </div>
        <div className="header-actions">
          {computer !== undefined && computer !== "off" && (
            <button
              type="button"
              className={`button ghost small computer-toggle${panelOpen ? " active" : ""}`}
              aria-pressed={panelOpen}
              onClick={onTogglePanel}
            >
              <ComputerIcon size={18} />
              <span className="computer-toggle-label">Computer</span>
              <span
                className={`state-dot ${computer ? computer.state : "none"}`}
                title={computer ? COMPUTER_STATES[computer.state] : "None yet"}
              />
              <span className="visually-hidden">{computer ? COMPUTER_STATES[computer.state] : "None yet"}</span>
            </button>
          )}
          <Menu label={`More for ${bot.name}`}>
            {(close) => (
              <>
                <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), start("renaming"))}>
                  Rename
                </button>
                <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), start("switching"))}>
                  Change model
                </button>
                <button type="button" role="menuitem" className="menu-item danger" onClick={() => (close(), start("deleting"))}>
                  Delete…
                </button>
              </>
            )}
          </Menu>
        </div>
      </PageHeader>
      {mode === "switching" && (
        <form className="header-bar" onSubmit={switchModel}>
          <label htmlFor="switch-model" className="small">
            Model
          </label>
          <ModelPicker id="switch-model" catalog={catalog} value={model} onChange={setModel} />
          <button type="submit" className="button primary small" disabled={!canUse(catalog, model) || model === bot.model}>
            Switch
          </button>
          <button type="button" className="button secondary small" onClick={() => setMode("idle")}>
            Cancel
          </button>
          <span className="muted small">The Conversation stays as it is.</span>
        </form>
      )}
      {mode === "deleting" && (
        <div className="header-bar danger-bar">
          <span>
            Delete {hasComputer ? `${bot.name}, its Conversation and its Computer` : `${bot.name} and its Conversation`}? This
            can't be undone.
          </span>
          <button type="button" className="button danger small" onClick={() => void remove()}>
            Delete {bot.name}
          </button>
          <button type="button" className="button secondary small" onClick={() => setMode("idle")}>
            Keep it
          </button>
        </div>
      )}
      {error && (
        <p className="alert header-alert" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
