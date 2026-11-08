import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, type Bot, type Computer, errorMessage, type Message, type ModelCatalog } from "../api.ts";
import { ComputerPanel } from "../ComputerPanel.tsx";
import { canUse, ModelPicker, modelLabel } from "../ModelPicker.tsx";
import { AppShell } from "../AppShell.tsx";

export function BotPage() {
  return <AppShell>{() => <BotChat />}</AppShell>;
}

/** One Bot: its name, and its conversation on the web Channel. */
function BotChat() {
  const { id = "" } = useParams();
  const [bot, setBot] = useState<Bot | null | undefined>(undefined);
  const [catalog, setCatalog] = useState<ModelCatalog>({ models: [], openrouter: false, local: false });
  const [messages, setMessages] = useState<Message[]>([]);
  // undefined while loading, "off" where no Computer service is set up, null for none yet.
  const [computer, setComputer] = useState<Computer | null | "off" | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.bots(), api.models(), api.messages(id)]).then(
      ([{ bots }, catalog, { messages }]) => {
        setBot(bots.find((candidate) => candidate.id === id) ?? null);
        setCatalog(catalog);
        setMessages(messages);
      },
      (caught: unknown) => {
        setBot(null);
        setError(errorMessage(caught));
      },
    );
    api.computer(id).then(
      ({ computer }) => setComputer(computer),
      (caught: unknown) => setComputer(caught instanceof ApiError && caught.code === "computers_off" ? "off" : null),
    );
  }, [id]);

  if (bot === undefined) return <main className="page muted">Loading…</main>;
  if (bot === null) {
    return (
      <main className="page">
        <p className="alert" role="alert">
          {error ?? "There's no such Bot."}
        </p>
        <Link to="/bots">Back to your Bots</Link>
      </main>
    );
  }

  return (
    <main className="page chat-page">
      <BotHeader bot={bot} catalog={catalog} hasComputer={Boolean(computer && computer !== "off")} onChange={setBot} />
      {computer !== undefined && computer !== "off" && (
        <ComputerPanel bot={bot} catalog={catalog} computer={computer} onChange={setComputer} onBotChange={setBot} />
      )}
      <Conversation bot={bot} messages={messages} onMessages={setMessages} />
    </main>
  );
}

function BotHeader({
  bot,
  catalog,
  hasComputer,
  onChange,
}: {
  bot: Bot;
  catalog: ModelCatalog;
  hasComputer: boolean;
  onChange: (bot: Bot) => void;
}) {
  const [switching, setSwitching] = useState(false);
  const [model, setModel] = useState(bot.model);
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(bot.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename(event: FormEvent) {
    event.preventDefault();
    try {
      const { bot: renamed } = await api.renameBot(bot.id, name);
      onChange(renamed);
      setRenaming(false);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function switchModel(event: FormEvent) {
    event.preventDefault();
    try {
      const { bot: switched } = await api.switchModel(bot.id, model);
      onChange(switched);
      setSwitching(false);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function remove() {
    try {
      await api.deleteBot(bot.id);
      navigate("/bots", { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="bot-head">
      <Link to="/bots" className="muted small">
        ← Bots
      </Link>
      {renaming ? (
        <form className="rename" onSubmit={rename}>
          <label htmlFor="rename" className="visually-hidden">
            Name
          </label>
          <input id="rename" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
          <button type="submit" className="button primary small">
            Save
          </button>
          <button type="button" className="button secondary small" onClick={() => setRenaming(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="bot-title">
          <h1>{bot.name}</h1>
          <span className="muted small">{modelLabel(catalog, bot.model)}</span>
          <div className="actions">
            <button type="button" className="button secondary small" onClick={() => setRenaming(true)}>
              Rename
            </button>
            <button type="button" className="button secondary small" onClick={() => setSwitching(true)}>
              Change model
            </button>
            {confirmingDelete ? (
              <>
                <button type="button" className="button danger small" onClick={remove}>
                  Delete {bot.name}, its conversation{hasComputer ? " and its Computer" : ""}
                </button>
                <button type="button" className="button secondary small" onClick={() => setConfirmingDelete(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" className="button secondary small" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            )}
          </div>
        </div>
      )}
      {switching && (
        <form className="rename" onSubmit={switchModel}>
          <label htmlFor="switch-model" className="visually-hidden">
            Model
          </label>
          <ModelPicker id="switch-model" catalog={catalog} value={model} onChange={setModel} />
          <button type="submit" className="button primary small" disabled={!canUse(catalog, model) || model === bot.model}>
            Switch
          </button>
          <button type="button" className="button secondary small" onClick={() => setSwitching(false)}>
            Cancel
          </button>
          <span className="muted small">The conversation stays as it is.</span>
        </form>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Conversation({
  bot,
  messages,
  onMessages,
}: {
  bot: Bot;
  messages: Message[];
  onMessages: (update: (messages: Message[]) => Message[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || streaming !== null) return;
    setDraft("");
    setError(null);
    onMessages((current) => [...current, { id: `pending-${Date.now()}`, role: "user", content, createdAt: new Date().toISOString() }]);
    setStreaming("");
    try {
      const reply = await api.sendMessage(
        bot.id,
        content,
        (text) => setStreaming((sofar) => (sofar ?? "") + text),
        (text) => setStatus(text),
      );
      onMessages((current) => [...current, reply]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStreaming(null);
      setStatus(null);
    }
  }

  function sendOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <>
      <div className="messages" aria-live="polite">
        {messages.length === 0 && streaming === null && (
          <p className="muted chat-empty">Say hello to {bot.name}. Your conversation is kept here.</p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`bubble ${message.role}`}>
            {message.content}
          </div>
        ))}
        {streaming !== null && (
          <div className="bubble assistant" aria-busy="true">
            {streaming || <span className="muted">Thinking…</span>}
            {status && <div className="muted small bot-status">{status}</div>}
          </div>
        )}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={sendMessage}>
        <label htmlFor="message" className="visually-hidden">
          Message {bot.name}
        </label>
        <textarea
          id="message"
          rows={2}
          placeholder={`Message ${bot.name}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={sendOnEnter}
        />
        <button type="submit" className="button primary" disabled={streaming !== null || !draft.trim()}>
          Send
        </button>
      </form>
    </>
  );
}
