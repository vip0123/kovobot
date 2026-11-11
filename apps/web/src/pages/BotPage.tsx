import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api, ApiError, type Approval, type Bot, type Computer, errorMessage, type Message, type ModelCatalog } from "../api.ts";
import { AppShell, PageHeader, useShell } from "../AppShell.tsx";
import { BotAvatar } from "../BotAvatar.tsx";
import { ComputerPanel } from "../ComputerPanel.tsx";
import { Conversation } from "../Conversation.tsx";
import { CustomizePanel } from "../CustomizePanel.tsx";
import { ChevronDownIcon, ComputerIcon, SlidersIcon } from "../Icons.tsx";
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

/** What the Tools tab says on coming back from an MCP server's sign-in. */
const MCP_OUTCOMES: Record<string, string> = {
  connected: "Signed in. The server's tools are ready.",
  failed: "Signing in to that MCP server didn't work. Try connecting it again.",
};

/** What the panel beside the Conversation shows, when open. */
type Drawer = "computer" | "customize";

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
  const updateMessages = useCallback((update: (messages: Message[]) => Message[]) => setMessages((current) => update(current ?? [])), []);
  // Each action the Bot asked to take, shown under the reply that asked.
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const updateApprovals = useCallback((update: (approvals: Approval[]) => Approval[]) => setApprovals(update), []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [computer, setComputer] = useState<ComputerState>(undefined);
  // Back from signing in to an MCP server: the Tools tab says how it went.
  const [searchParams, setSearchParams] = useSearchParams();
  const [mcpNotice] = useState(() => MCP_OUTCOMES[searchParams.get("mcp") ?? ""] ?? null);
  const [drawer, setDrawer] = useState<Drawer | null>(mcpNotice ? "customize" : null);
  useEffect(() => {
    if (searchParams.has("mcp")) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!exists) return;
    api.messages(id).then(
      ({ messages, approvals }) => {
        setMessages(messages);
        setApprovals(approvals);
      },
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
        drawer={drawer}
        onToggleDrawer={(which) => setDrawer(drawer === which ? null : which)}
        onChange={saveBot}
      />
      <div className="bot-body">
        <Conversation
          bot={bot}
          catalog={catalog}
          messages={messages}
          approvals={approvals}
          loadError={loadError}
          onMessages={updateMessages}
          onApprovals={updateApprovals}
          canUseComputer={Boolean(computer && computer !== "off" && bot.driverModel)}
        />
        {drawer === "computer" && computer !== undefined && computer !== "off" && (
          <aside className="side-drawer" aria-label={`${bot.name}'s Computer`}>
            <ComputerPanel
              bot={bot}
              catalog={catalog}
              computer={computer}
              onChange={setComputer}
              onBotChange={saveBot}
              onClose={() => setDrawer(null)}
            />
          </aside>
        )}
        {drawer === "customize" && (
          <aside className="side-drawer" aria-label={`Customize ${bot.name}`}>
            <CustomizePanel
              bot={bot}
              conversationLength={messages?.length ?? 0}
              onBotChange={saveBot}
              onClose={() => setDrawer(null)}
              openOn={mcpNotice ? "tools" : undefined}
              notice={mcpNotice ?? undefined}
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
  drawer,
  onToggleDrawer,
  onChange,
}: {
  bot: Bot;
  catalog: ModelCatalog;
  computer: ComputerState;
  drawer: Drawer | null;
  onToggleDrawer: (which: Drawer) => void;
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
          <button
            type="button"
            className={`button ghost small drawer-toggle customize-toggle${drawer === "customize" ? " active" : ""}`}
            aria-pressed={drawer === "customize"}
            onClick={() => onToggleDrawer("customize")}
          >
            <SlidersIcon size={18} />
            <span className="drawer-toggle-label">Customize</span>
          </button>
          {computer !== undefined && computer !== "off" && (
            <button
              type="button"
              className={`button ghost small drawer-toggle${drawer === "computer" ? " active" : ""}`}
              aria-pressed={drawer === "computer"}
              onClick={() => onToggleDrawer("computer")}
            >
              <ComputerIcon size={18} />
              <span className="drawer-toggle-label">Computer</span>
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
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    close();
                    if (drawer !== "customize") onToggleDrawer("customize");
                  }}
                >
                  Customize
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
