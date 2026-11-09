import { type FormEvent, type KeyboardEvent, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, type Bot, type Computer, errorMessage, type Message, type ModelCatalog } from "../api.ts";
import { AppShell, PageHeader, useShell } from "../AppShell.tsx";
import { BotAvatar } from "../BotAvatar.tsx";
import { ComputerPanel } from "../ComputerPanel.tsx";
import { CheckIcon, ChevronDownIcon, ComputerIcon, CopyIcon, SendIcon } from "../Icons.tsx";
import { Menu } from "../Menu.tsx";
import { canUse, ModelPicker, modelLabel } from "../ModelPicker.tsx";

// The Markdown renderer loads with the first Bot page, not with sign-in; until then a reply shows as plain text.
const Markdown = lazy(() => import("../Markdown.tsx").then(({ Markdown }) => ({ default: Markdown })));

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

const SUGGESTIONS = [
  { label: "Explain something", prompt: "Explain how compound interest works, in plain words." },
  { label: "Draft a message", prompt: "Draft a short, friendly message declining a meeting next week." },
  { label: "Plan my day", prompt: "Help me plan a focused workday around three priorities." },
];
const COMPUTER_SUGGESTION = {
  label: "Use your Computer",
  prompt: "Use your Computer: open Firefox, find today's top news headline and tell me what it says.",
};

function Conversation({
  bot,
  catalog,
  messages,
  loadError,
  onMessages,
  canUseComputer,
}: {
  bot: Bot;
  catalog: ModelCatalog;
  messages: Message[] | null;
  loadError: string | null;
  onMessages: (update: (messages: Message[]) => Message[]) => void;
  canUseComputer: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const empty = messages !== null && messages.length === 0 && streaming === null;
  const suggestions = canUseComputer ? [...SUGGESTIONS, COMPUTER_SUGGESTION] : SUGGESTIONS;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  // The box grows with what's typed, up to a limit, then scrolls.
  useLayoutEffect(() => {
    const textarea = box.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [draft]);

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || streaming !== null) return;
    setDraft("");
    setError(null);
    onMessages((current) => [...current, { id: `pending-${Date.now()}`, role: "user", content, createdAt: new Date().toISOString() }]);
    setStreaming("");
    let written = "";
    try {
      const reply = await api.sendMessage(
        bot.id,
        content,
        (text) => {
          written += text;
          setStreaming(written);
          // Writing again means whatever the Bot was doing, such as using its Computer, is over.
          setStatus(null);
        },
        setStatus,
      );
      onMessages((current) => [...current, reply]);
    } catch (caught) {
      // The Bot service keeps what the model already wrote, so the page keeps it too.
      if (written) {
        onMessages((current) => [
          ...current,
          { id: `partial-${Date.now()}`, role: "assistant", content: written, createdAt: new Date().toISOString() },
        ]);
      }
      setError(errorMessage(caught));
    } finally {
      setStreaming(null);
      setStatus(null);
      box.current?.focus();
    }
  }

  function sendOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function suggest(prompt: string) {
    setDraft(prompt);
    box.current?.focus();
  }

  return (
    <section className={`conversation${empty ? " is-empty" : ""}`} aria-label={`Conversation with ${bot.name}`}>
      <div className="scroller">
        <div className="column" aria-live="polite">
          {messages === null && <p className="muted loading-line">Loading the Conversation…</p>}
          {loadError && (
            <p className="alert" role="alert">
              {loadError}
            </p>
          )}
          {empty && (
            <div className="greeting">
              <BotAvatar id={bot.id} name={bot.name} size="large" />
              <h2>What should {bot.name} do?</h2>
              <p className="muted">
                {bot.name} thinks with {modelLabel(catalog, bot.model)}. Your Conversation is kept here.
              </p>
            </div>
          )}
          {messages?.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="message user">
                <div className="user-text">{message.content}</div>
              </div>
            ) : (
              <BotMessage key={message.id} bot={bot} text={message.content} />
            ),
          )}
          {streaming !== null && <BotMessage bot={bot} text={streaming} streaming status={status} />}
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          <div ref={end} />
        </div>
      </div>
      <div className="composer-area">
        <form className="composer" onSubmit={sendMessage}>
          <label htmlFor="message" className="visually-hidden">
            Message {bot.name}
          </label>
          <textarea
            id="message"
            ref={box}
            rows={1}
            autoFocus
            placeholder={`Message ${bot.name}…`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={sendOnEnter}
          />
          <button type="submit" className="send-button" aria-label="Send" disabled={streaming !== null || !draft.trim()}>
            <SendIcon size={18} />
          </button>
        </form>
        {empty ? (
          <div className="suggestions">
            {suggestions.map((suggestion) => (
              <button key={suggestion.label} type="button" className="chip" onClick={() => suggest(suggestion.prompt)}>
                {suggestion.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="composer-hint">Enter to send · Shift + Enter for a new line</p>
        )}
      </div>
    </section>
  );
}

/** One of the Bot's replies, or the one it's writing now: Markdown, with a copy button once done. */
function BotMessage({
  bot,
  text,
  streaming = false,
  status = null,
}: {
  bot: Bot;
  text: string;
  streaming?: boolean;
  status?: string | null;
}) {
  return (
    <div className="message bot" aria-busy={streaming || undefined}>
      <BotAvatar id={bot.id} name={bot.name} size="small" />
      <div className="bot-text">
        {text ? (
          <Suspense fallback={<div className="markdown plain">{text}</div>}>
            <Markdown text={text} />
          </Suspense>
        ) : (
          <span className="typing" role="status" aria-label={`${bot.name} is thinking`}>
            <span />
            <span />
            <span />
          </span>
        )}
        {status && (
          <span className="status-chip">
            <span className="logo-mark pulse" aria-hidden="true" />
            {status}
          </span>
        )}
        {!streaming && text && <CopyButton text={text} />}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The browser refused the clipboard; the text can still be selected by hand.
    }
  }

  return (
    <div className="message-tools">
      <button
        type="button"
        className="icon-button tiny"
        aria-label={copied ? "Copied" : "Copy the reply"}
        title={copied ? "Copied" : "Copy the reply"}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      </button>
    </div>
  );
}
