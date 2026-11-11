import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  api,
  ApiError,
  type Approval,
  type Attachment,
  type Bot,
  errorMessage,
  type Message,
  type ModelCatalog,
  type ReplyHandlers,
  type WebSource,
} from "./api.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import {
  BulbIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  FileIcon,
  GlobeIcon,
  MicIcon,
  PaperclipIcon,
  ResearchIcon,
  SendIcon,
  SpeakerIcon,
  StopIcon,
} from "./Icons.tsx";
import { modelLabel } from "./ModelPicker.tsx";

// The Markdown renderer loads with the first Bot page, not with sign-in; until then a reply shows as plain text.
const Markdown = lazy(() => import("./Markdown.tsx").then(({ Markdown }) => ({ default: Markdown })));

// The API's limits (apps/api/src/attachments.ts), checked here first so a too-big Attachment is
// caught before it's read. The API decides by the file's bytes; here, by its type and name.
const MAX_FILES = 5;
/** How often an open, idle Conversation looks for replies it didn't ask for, such as a schedule's. */
const NEW_MESSAGES_POLL_MS = 15_000;
const MB = 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * MB;
const limitFor = (file: File): { bytes: number; label: string } =>
  file.type.startsWith("image/")
    ? { bytes: 5 * MB, label: "5 MB for an image" }
    : file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
      ? { bytes: 10 * MB, label: "10 MB for a PDF" }
      : { bytes: MB / 2, label: "512 KB for a text file" };
const ACCEPTED =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.json,.txt,.log,.xml,.yaml,.yml,.ts,.tsx,.js,.py,.html,.css,.sql";

const SUGGESTIONS = [
  { label: "Explain something", prompt: "Explain how compound interest works, in plain words." },
  { label: "Draft a message", prompt: "Draft a short, friendly message declining a meeting next week." },
  { label: "Plan my day", prompt: "Help me plan a focused workday around three priorities." },
];
const COMPUTER_SUGGESTION = {
  label: "Use your Computer",
  prompt: "Use your Computer: open Firefox, find today's top news headline and tell me what it says.",
};

/** A reply as it streams in: its text, what the model thinks first, the pages it found, and the actions it asks to take. */
interface StreamingReply {
  text: string;
  thinking: string;
  sources: WebSource[];
  searchSuggestions?: string;
  /** The Approvals this reply's Task asked for, which show under it once it's saved. */
  asked: Set<string>;
  /** The pictures the Bot made so far, shown from their own data until the reply is saved. */
  pictures: Attachment[];
}

function newReply(): StreamingReply {
  return { text: "", thinking: "", sources: [], asked: new Set(), pictures: [] };
}

/** An id for a message shown before it's saved, which the saved one's numeric id never matches. */
function localId(kind: "pending" | "partial"): string {
  return `${kind}-${Date.now()}`;
}

/** The Model provider a model id belongs to, as the catalog and its route prefix say. */
function providerOf(catalog: ModelCatalog, model: string): string | undefined {
  if (model.startsWith("openrouter:")) return "openrouter";
  if (model.startsWith("local:")) return "local";
  return catalog.models.find((listed) => listed.id === model)?.provider;
}

/** What a voice note is recorded as, best first: the browser takes the first it can make. */
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
/** The longest voice note, in seconds; well inside the 10 MB a recording may be. */
const MAX_RECORDING_SECONDS = 300;

/** A file picked to send, with a preview for images. */
interface Picked {
  file: File;
  preview?: string;
}

/** The Bot's Conversation on the web Channel, and the box to write in. */
export function Conversation({
  bot,
  catalog,
  messages,
  approvals,
  loadError,
  onMessages,
  onApprovals,
  canUseComputer,
}: {
  bot: Bot;
  catalog: ModelCatalog;
  messages: Message[] | null;
  /** Each action the Bot asked to take, shown under the reply that asked. */
  approvals: Approval[];
  loadError: string | null;
  onMessages: (update: (messages: Message[]) => Message[]) => void;
  onApprovals: (update: (approvals: Approval[]) => Approval[]) => void;
  canUseComputer: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [thinkHarder, setThinkHarder] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [research, setResearch] = useState(false);
  const [dragging, setDragging] = useState(false);
  // The reply being written: its text, what the model thinks first, and the pages it found.
  const [streaming, setStreaming] = useState<{
    text: string;
    thinking: string;
    sources: WebSource[];
    searchSuggestions?: string;
    pictures: Attachment[];
  } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const empty = messages !== null && messages.length === 0 && streaming === null;
  const suggestions = canUseComputer ? [...SUGGESTIONS, COMPUTER_SUGGESTION] : SUGGESTIONS;
  const provider = providerOf(catalog, bot.model);
  const canSearch = (catalog.webSearch ?? []).includes(provider ?? "");
  const searching = webSearch && canSearch;
  // Deep research searches the web in rounds, so it's offered wherever web search is.
  const researching = research && canSearch;
  // xAI isn't sent reasoning options yet (unchecked there), so thinking deeper would do nothing.
  const canThinkHarder = provider !== "xai";
  const thinksHarder = thinkHarder && canThinkHarder;
  const canHear = catalog.voice?.hear === true;
  const canListen = catalog.voice?.speak === true;
  // A voice note being recorded, how long it has run, and whether stopping it sends it.
  const [recording, setRecording] = useState<MediaRecorder | null>(null);
  const [recordedSeconds, setRecordedSeconds] = useState(0);
  const sendRecording = useRef(false);
  // The reply being read aloud, if any, and its player.
  const [speech, setSpeech] = useState<{ messageId: string; state: "loading" | "playing" } | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const listeningTo = useRef<string | null>(null);

  // The recording's clock, which stops it at the longest a voice note may be.
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      setRecordedSeconds(seconds);
      if (seconds >= MAX_RECORDING_SECONDS && recording.state === "recording") {
        sendRecording.current = true;
        recording.stop();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  // Leaving the Conversation stops a reply being read aloud.
  useEffect(() => () => player.current?.pause(), []);

  async function startRecording() {
    if (recording || streaming !== null) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Kovobot can't use your microphone. Allow it in your browser's site settings, then try again.");
      return;
    }
    const mimeType = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      setRecording(null);
      if (sendRecording.current && chunks.length > 0) void sendMessage(undefined, new Blob(chunks, { type: recorder.mimeType }));
    };
    sendRecording.current = false;
    setRecordedSeconds(0);
    recorder.start(1000);
    setRecording(recorder);
  }

  /** Stops recording, and sends the voice note or throws it away. */
  function stopRecording(send: boolean) {
    sendRecording.current = send;
    if (recording?.state === "recording") recording.stop();
  }

  /** Reads one of the Bot's replies aloud, or stops it if it's the one being read. */
  async function listen(messageId: string) {
    const again = listeningTo.current === messageId;
    stopListening();
    if (again) return;
    listeningTo.current = messageId;
    setSpeech({ messageId, state: "loading" });
    try {
      const url = URL.createObjectURL(await api.speech(bot.id, messageId));
      if (listeningTo.current !== messageId) return URL.revokeObjectURL(url);
      const audio = new Audio(url);
      player.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (listeningTo.current === messageId) stopListening();
      };
      setSpeech({ messageId, state: "playing" });
      await audio.play();
    } catch (caught) {
      if (listeningTo.current === messageId) stopListening();
      setError(errorMessage(caught));
    }
  }

  function stopListening() {
    player.current?.pause();
    player.current = null;
    listeningTo.current = null;
    setSpeech(null);
  }

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  // Replies the page didn't ask for, such as a schedule's, arrive while it's open: it looks for
  // them every so often while it isn't sending, and only while it's on screen.
  const lastSaved = messages?.findLast((message) => /^\d+$/.test(message.id))?.id ?? null;
  const idle = messages !== null && streaming === null;
  useEffect(() => {
    if (!idle) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      api.messages(bot.id).then(
        ({ messages: saved, approvals: asked }) => {
          if (saved.at(-1)?.id === lastSaved) return;
          onMessages(() => saved);
          onApprovals(() => asked);
        },
        () => {},
      );
    }, NEW_MESSAGES_POLL_MS);
    return () => clearInterval(timer);
  }, [bot.id, idle, lastSaved, onMessages, onApprovals]);

  // The box grows with what's typed, up to a limit, then scrolls.
  useLayoutEffect(() => {
    const textarea = box.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [draft]);

  function pick(files: FileList | File[]) {
    const next = [...picked];
    for (const file of Array.from(files)) {
      if (next.length >= MAX_FILES) {
        setError(`Attach up to ${MAX_FILES} files at a time.`);
        break;
      }
      const limit = limitFor(file);
      if (file.size > limit.bytes) {
        setError(`${file.name} is too big: ${limit.label} at most.`);
        continue;
      }
      next.push({ file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined });
    }
    if (next.reduce((sum, { file }) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
      setError("These files come to more than 12 MB: send fewer at a time.");
      return;
    }
    setPicked(next);
  }

  function unpick(index: number) {
    const preview = picked[index]?.preview;
    if (preview) URL.revokeObjectURL(preview);
    setPicked(picked.filter((_, at) => at !== index));
  }

  /** Sends what's written and attached, and, from the microphone, a voice note whose words join them. */
  async function sendMessage(event?: FormEvent, voice?: Blob) {
    event?.preventDefault();
    const content = draft.trim();
    if ((!content && picked.length === 0 && !voice) || streaming !== null) return;
    setError(null);
    let attachments;
    let voiceNote;
    try {
      attachments = await Promise.all(picked.map(async ({ file }) => ({ name: file.name, data: await base64(file) })));
      if (voice) voiceNote = { data: await base64(voice) };
    } catch {
      setError(voice ? "The recording couldn't be read. Record it again." : "An Attachment couldn't be read. Pick it again.");
      return;
    }
    const sentFiles: Attachment[] = picked.map(({ file, preview }) => ({ name: file.name, mediaType: file.type, size: file.size, preview }));
    // The recording plays from the browser until the saved message, with what it said, replaces it.
    if (voice) sentFiles.push({ name: "Voice note", mediaType: voice.type || "audio/webm", size: voice.size, preview: URL.createObjectURL(voice) });
    const pendingId = localId("pending");
    const unsent = { draft, picked };
    setDraft("");
    setPicked([]);
    onMessages((current) => [
      ...current,
      { id: pendingId, role: "user", content, attachments: sentFiles, createdAt: new Date().toISOString() },
    ]);
    const reply = newReply();
    setStreaming({ ...reply });
    try {
      const saved = await api.sendMessage(
        bot.id,
        content,
        { attachments, thinkHarder: thinksHarder, webSearch: searching, research: researching, ...(voiceNote ? { voiceNote } : {}) },
        {
          ...replyHandlers(reply),
          // The saved message replaces the one shown while sending, so its Attachments link straight away.
          onSent: (saved) => {
            onMessages((current) => current.map((message) => (message.id === pendingId ? saved : message)));
            for (const file of sentFiles) if (file.preview) URL.revokeObjectURL(file.preview);
          },
        },
      );
      replySaved(saved, reply);
      // Spoken to, the Bot answers aloud too.
      if (voice && canListen) void listen(saved.id);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status >= 400) {
        // Refused before it was saved (too big, a file it can't take, the Bot busy): put it all back.
        onMessages((current) => current.filter((message) => message.id !== pendingId));
        setDraft(unsent.draft);
        setPicked(unsent.picked);
      } else {
        keepPartial(reply);
      }
      setError(errorMessage(caught));
    } finally {
      setStreaming(null);
      setStatus(null);
      box.current?.focus();
    }
  }

  /**
   * Approves or declines an action the Bot asked to take. Approved, it runs once; either way the
   * Bot hears the decision and carries on, its reply streaming in as for a message.
   */
  async function decide(approval: Approval, decision: "approve" | "decline", alwaysAllow: boolean) {
    if (streaming !== null) return;
    setError(null);
    const reply = newReply();
    setStreaming({ ...reply });
    try {
      const saved = await api.decideApproval(
        bot.id,
        approval.id,
        { decision, alwaysAllow },
        {
          ...replyHandlers(reply),
          // The decision as the Bot hears it: kept with the messages, shown on the Approval's card.
          onSent: (message) => onMessages((current) => [...current, message]),
        },
      );
      replySaved(saved, reply);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status >= 400) {
        // Decided already, perhaps in another tab, or the Bot busy: show things as they now are.
        api.messages(bot.id).then(
          ({ messages: saved, approvals: asked }) => {
            onMessages(() => saved);
            onApprovals(() => asked);
          },
          () => {},
        );
      } else {
        keepPartial(reply);
      }
      setError(errorMessage(caught));
    } finally {
      setStreaming(null);
      setStatus(null);
    }
  }

  /** What a streamed reply does to the page as it arrives; `reply` collects it. */
  function replyHandlers(reply: StreamingReply): ReplyHandlers {
    return {
      onText: (text) => {
        reply.text += text;
        setStreaming({ ...reply });
        // Writing again means whatever the Bot was doing, such as using its Computer, is over.
        setStatus(null);
      },
      onThinking: (text) => {
        reply.thinking += text;
        setStreaming({ ...reply });
      },
      onSources: (sources, searchSuggestions) => {
        reply.sources = [...reply.sources, ...sources.filter((page) => !reply.sources.some((other) => other.url === page.url))];
        reply.searchSuggestions = searchSuggestions ?? reply.searchSuggestions;
        setStreaming({ ...reply });
      },
      onStatus: setStatus,
      onImage: ({ name, mediaType, prompt, data }) => {
        const size = Math.floor((data.length * 3) / 4);
        reply.pictures = [...reply.pictures, { name, mediaType, prompt, size, preview: `data:${mediaType};base64,${data}` }];
        setStreaming({ ...reply });
      },
      // An action the Bot asks to take shows as it asks; news of one updates its card.
      onApproval: (approval) => {
        if (approval.messageId === null) reply.asked.add(approval.id);
        onApprovals((current) =>
          current.some((each) => each.id === approval.id)
            ? current.map((each) => (each.id === approval.id ? approval : each))
            : [...current, approval],
        );
      },
    };
  }

  /** The reply is saved: the actions its Task asked to take now show under it. */
  function replySaved(saved: Message, reply: StreamingReply) {
    onMessages((current) => [...current, saved]);
    onApprovals((current) => current.map((each) => (reply.asked.has(each.id) ? { ...each, messageId: saved.id } : each)));
  }

  /** The Bot service keeps what the model already wrote when a reply stops early, so the page keeps it too. */
  function keepPartial(reply: StreamingReply) {
    if (!reply.text && reply.pictures.length === 0) return;
    onMessages((current) => [
      ...current,
      {
        id: localId("partial"),
        role: "assistant",
        content: reply.text,
        thinking: reply.thinking || null,
        sources: reply.sources,
        searchSuggestions: reply.searchSuggestions ?? null,
        attachments: reply.pictures,
        createdAt: new Date().toISOString(),
      },
    ]);
  }

  function sendOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function pasteFiles(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (event.clipboardData.files.length === 0) return;
    event.preventDefault();
    pick(event.clipboardData.files);
  }

  function dropFiles(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) pick(event.dataTransfer.files);
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
            // A decision on an Approval is for the Bot: its card already shows it.
            message.approvalId ? null : message.role === "user" ? (
              <UserMessage key={message.id} bot={bot} message={message} />
            ) : (
              <Fragment key={message.id}>
                <BotMessage
                  bot={bot}
                  text={message.content}
                  thinking={message.thinking ?? ""}
                  sources={message.sources ?? []}
                  searchSuggestions={message.searchSuggestions ?? undefined}
                  files={message.attachments ?? []}
                  listen={
                    canListen && /^\d+$/.test(message.id)
                      ? { state: speech?.messageId === message.id ? speech.state : "idle", onToggle: () => void listen(message.id) }
                      : undefined
                  }
                />
                {approvals
                  .filter((approval) => approval.messageId === message.id)
                  .map((approval) => (
                    <ApprovalCard key={approval.id} bot={bot} approval={approval} busy={streaming !== null} onDecide={decide} />
                  ))}
              </Fragment>
            ),
          )}
          {streaming !== null && (
            <BotMessage
              bot={bot}
              text={streaming.text}
              thinking={streaming.thinking}
              sources={streaming.sources}
              searchSuggestions={streaming.searchSuggestions}
              files={streaming.pictures}
              streaming
              status={status}
            />
          )}
          {/* Asked by the reply being written, or by one that stopped before it was saved. */}
          {approvals
            .filter((approval) => approval.messageId === null || !messages?.some((message) => message.id === approval.messageId))
            .map((approval) => (
              <ApprovalCard key={approval.id} bot={bot} approval={approval} busy={streaming !== null} onDecide={decide} />
            ))}
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          <div ref={end} />
        </div>
      </div>
      <div className="composer-area">
        <form
          className={`composer${dragging ? " dragging" : ""}`}
          onSubmit={sendMessage}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={dropFiles}
        >
          {picked.length > 0 && (
            <ul className="picked" aria-label="Files to send">
              {picked.map(({ file, preview }, index) => (
                <li key={`${file.name}-${index}`} className="picked-file">
                  {preview ? <img src={preview} alt="" className="picked-thumb" /> : <FileIcon size={18} />}
                  <span className="picked-name" title={file.name}>
                    {file.name}
                  </span>
                  <span className="picked-size">{formatSize(file.size)}</span>
                  <button type="button" className="icon-button tiny" aria-label={`Remove ${file.name}`} onClick={() => unpick(index)}>
                    <CloseIcon size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label htmlFor="message" className="visually-hidden">
            Message {bot.name}
          </label>
          <textarea
            id="message"
            ref={box}
            rows={1}
            autoFocus
            placeholder={researching ? `What should ${bot.name} research?` : `Message ${bot.name}…`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={sendOnEnter}
            onPaste={pasteFiles}
            disabled={recording !== null}
          />
          {recording ? (
            <div className="recording-bar" role="status">
              <span className="recording-dot" aria-hidden="true" />
              <span className="recording-time">Recording {formatSeconds(recordedSeconds)}</span>
              <button type="button" className="button ghost small" onClick={() => stopRecording(false)}>
                Cancel
              </button>
              <button type="button" className="button primary small" onClick={() => stopRecording(true)}>
                Send voice note
              </button>
            </div>
          ) : (
          <div className="composer-tools">
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPTED}
              className="visually-hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                if (event.target.files) pick(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Attach files"
              title="Attach images, PDFs or text files"
              onClick={() => fileInput.current?.click()}
            >
              <PaperclipIcon size={19} />
            </button>
            {canHear && (
              <button
                type="button"
                className="icon-button"
                aria-label="Record a voice note"
                title="Record a voice note: what you say is sent as your message"
                disabled={streaming !== null}
                onClick={() => void startRecording()}
              >
                <MicIcon size={19} />
              </button>
            )}
            {canThinkHarder && (
              <button
                type="button"
                className={`toggle${thinkHarder ? " on" : ""}`}
                aria-label="Think deeper"
                aria-pressed={thinkHarder}
                title="The model takes longer and thinks harder"
                onClick={() => setThinkHarder(!thinkHarder)}
              >
                <BulbIcon size={17} />
                <span className="toggle-label">Think deeper</span>
              </button>
            )}
            {canSearch && (
              <button
                type="button"
                className={`toggle${webSearch ? " on" : ""}`}
                aria-label="Search the web"
                aria-pressed={webSearch}
                title="The model may search the web and says where it found things"
                onClick={() => setWebSearch(!webSearch)}
              >
                <GlobeIcon size={17} />
                <span className="toggle-label">Search the web</span>
              </button>
            )}
            {canSearch && (
              <button
                type="button"
                className={`toggle${research ? " on" : ""}`}
                aria-label="Deep research"
                aria-pressed={research}
                title="The Bot searches and reads many pages, then writes a report with its sources. It takes a few minutes."
                onClick={() => setResearch(!research)}
              >
                <ResearchIcon size={17} />
                <span className="toggle-label">Deep research</span>
              </button>
            )}
            <button
              type="submit"
              className="send-button"
              aria-label="Send"
              disabled={streaming !== null || (!draft.trim() && picked.length === 0)}
            >
              <SendIcon size={18} />
            </button>
          </div>
          )}
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
          <p className="composer-hint">Enter to send · Shift + Enter for a new line · drop or paste files to attach</p>
        )}
      </div>
    </section>
  );
}

/** One of the Customer's messages: its files, then its words. */
/** How each kind of action reads on its card. */
const ACTION_KINDS: Record<Approval["kind"], { label: string; verb: string }> = {
  send: { label: "Sends", verb: "send" },
  change: { label: "Changes", verb: "change things" },
  delete: { label: "Deletes", verb: "delete" },
  pay: { label: "Pays", verb: "move money" },
};

/** What came of an action, once it's decided. */
function approvalOutcome(approval: Approval): string {
  switch (approval.state) {
    case "running":
      return "Running…";
    case "done":
      return approval.preApproved ? "Ran under your Pre-approval." : "Approved, and done.";
    case "failed":
      return "Approved, but it failed.";
    case "declined":
      return "Declined. It didn't run.";
    case "unknown":
      return "Kovobot restarted while this ran, so whether it happened can't be said. It won't run again: check, and ask again if needed.";
    case "waiting":
      return "";
  }
}

/**
 * An action the Bot asked to take, exactly as it would run: the Customer approves or declines it,
 * and may pre-approve that kind of action on that tool, except paying.
 */
function ApprovalCard({
  bot,
  approval,
  busy,
  onDecide,
}: {
  bot: Bot;
  approval: Approval;
  busy: boolean;
  onDecide: (approval: Approval, decision: "approve" | "decline", alwaysAllow: boolean) => void;
}) {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const kind = ACTION_KINDS[approval.kind];
  const values = Object.entries(approval.arguments);
  const waiting = approval.state === "waiting";
  return (
    <section
      className={`approval${waiting ? " waiting" : ""}`}
      aria-label={waiting ? `${bot.name} asks to use ${approval.tool.name}` : `${bot.name}'s action: ${approval.tool.name}`}
    >
      <div className="approval-head">
        <span className={`badge kind-${approval.kind}`}>{kind.label}</span>
        <span className="approval-tool">
          {approval.tool.label} · <code>{approval.tool.name}</code>
        </span>
      </div>
      {waiting && (
        <p className="approval-ask">
          {bot.name} asks to {kind.verb} with this. It runs exactly as shown, once, and only if you approve.
        </p>
      )}
      {values.length > 0 && (
        <dl className="approval-args">
          {values.map(([name, value]) => (
            <Fragment key={name}>
              <dt>{name}</dt>
              <dd>{typeof value === "string" ? value : JSON.stringify(value, null, 1)}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {waiting ? (
        <>
          {approval.kind === "pay" ? (
            <p className="muted small">Paying always waits for your Approval.</p>
          ) : (
            <label className="approval-always small">
              <input type="checkbox" checked={alwaysAllow} onChange={(event) => setAlwaysAllow(event.target.checked)} />
              Pre-approve: let {bot.name} {kind.verb} with <code>{approval.tool.name}</code> without asking
            </label>
          )}
          <div className="approval-actions">
            <button type="button" className="button primary small" disabled={busy} onClick={() => onDecide(approval, "approve", alwaysAllow)}>
              Approve
            </button>
            <button type="button" className="button ghost small" disabled={busy} onClick={() => onDecide(approval, "decline", false)}>
              Decline
            </button>
          </div>
        </>
      ) : (
        <p className={`approval-outcome small ${approval.state}`}>{approvalOutcome(approval)}</p>
      )}
      {approval.result && (approval.state === "done" || approval.state === "failed") && (
        <details className="approval-result small">
          <summary>What it returned</summary>
          <pre>{approval.result}</pre>
        </details>
      )}
    </section>
  );
}

function UserMessage({ bot, message }: { bot: Bot; message: Message }) {
  const files = message.attachments ?? [];
  // A schedule's firing sent it, not the Customer: shown as the task it is.
  if (message.scheduleId !== undefined && message.scheduleId !== null) {
    return (
      <div className="message scheduled">
        <span className="scheduled-label">
          <ClockIcon size={14} />
          Scheduled task
        </span>
        <div className="scheduled-text">{message.content}</div>
      </div>
    );
  }
  return (
    <div className="message user">
      {files.length > 0 && <MessageFiles bot={bot} files={files} className="user-files" />}
      {message.content && <div className="user-text">{message.content}</div>}
    </div>
  );
}

/** A message's files: images as pictures that open full size, anything else as a file to download. */
function MessageFiles({ bot, files, className }: { bot: Bot; files: Attachment[]; className: string }) {
  return (
    <div className={className}>
      {files.map((file, index) => {
        const url = file.id ? api.attachmentUrl(bot.id, file.id) : undefined;
        // A voice note's recording plays here; its words are the message.
        if (file.mediaType.startsWith("audio/") && (url ?? file.preview)) {
          return <audio key={file.id ?? index} className="voice-note" controls preload="none" src={url ?? file.preview} aria-label="Voice note" />;
        }
        const image = file.mediaType.startsWith("image/");
        if (image && (file.preview ?? url)) {
          return (
            <a
              key={file.id ?? index}
              href={url ?? file.preview}
              target="_blank"
              rel="noopener noreferrer"
              className="file-thumb"
              title={file.prompt}
            >
              <img src={file.preview ?? url} alt={file.prompt ?? file.name} />
            </a>
          );
        }
        return (
          <a key={file.id ?? index} href={url} download={file.name} className="file-chip">
            <FileIcon size={16} />
            <span className="file-chip-name">{file.name}</span>
            <span className="file-chip-size">{formatSize(file.size)}</span>
          </a>
        );
      })}
    </div>
  );
}

/** One of the Bot's replies, or the one it's writing now: what it thought, its words, its sources. */
function BotMessage({
  bot,
  text,
  thinking,
  sources,
  searchSuggestions,
  files = [],
  streaming = false,
  status = null,
  listen,
}: {
  bot: Bot;
  text: string;
  thinking: string;
  sources: WebSource[];
  searchSuggestions?: string;
  /** Files the reply came with, such as a research report. */
  files?: Attachment[];
  streaming?: boolean;
  status?: string | null;
  /** Reading the reply aloud, where replies can be: whether it is, and how to start or stop it. */
  listen?: { state: "idle" | "loading" | "playing"; onToggle: () => void };
}) {
  // Open while the model is still thinking; folded away once it answers.
  const thinkingNow = streaming && !text;
  return (
    <div className="message bot" aria-busy={streaming || undefined}>
      <BotAvatar id={bot.id} name={bot.name} size="small" />
      <div className="bot-text">
        {thinking && (
          <details className="thinking" key={thinkingNow ? "now" : "done"} open={thinkingNow}>
            <summary>
              {thinkingNow && <span className="logo-mark pulse" aria-hidden="true" />}
              {thinkingNow ? "Thinking…" : "Thought process"}
            </summary>
            <div className="thinking-text">{thinking}</div>
          </details>
        )}
        {text ? (
          <Suspense fallback={<div className="markdown plain">{text}</div>}>
            <Markdown text={text} />
          </Suspense>
        ) : (
          !thinking && (
            <span className="typing" role="status" aria-label={`${bot.name} is thinking`}>
              <span />
              <span />
              <span />
            </span>
          )
        )}
        {status && (
          <span className="status-chip">
            <span className="logo-mark pulse" aria-hidden="true" />
            {status}
          </span>
        )}
        {files.length > 0 && <MessageFiles bot={bot} files={files} className="bot-files" />}
        {sources.length > 0 && <Sources sources={sources} searchSuggestions={searchSuggestions} />}
        {!streaming && text && (
          <div className="message-tools">
            <CopyButton text={text} />
            {listen && <ListenButton {...listen} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** The pages a reply drew on, and Google's search suggestions when Google Search grounded it. */
function Sources({ sources, searchSuggestions }: { sources: WebSource[]; searchSuggestions?: string }) {
  return (
    <div className="sources">
      <span className="sources-label">Sources</span>
      <ol className="source-list">
        {sources.map((source, index) => (
          <li key={source.url}>
            <a href={source.url} target="_blank" rel="noopener noreferrer" className="source" title={source.url}>
              <span className="source-index">{index + 1}</span>
              <span className="source-title">{source.title}</span>
            </a>
          </li>
        ))}
      </ol>
      {searchSuggestions && (
        // Google's own HTML, shown as Google asks, in a frame that can't run scripts or touch the page.
        <iframe
          className="search-suggestions"
          title="Google Search suggestions"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          // Declaring both colour schemes keeps the frame see-through in dark mode instead of white.
          srcDoc={`<meta name="color-scheme" content="light dark"><base target="_blank"><style>body{margin:0}</style>${searchSuggestions}`}
        />
      )}
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
    <button
      type="button"
      className="icon-button tiny"
      aria-label={copied ? "Copied" : "Copy the reply"}
      title={copied ? "Copied" : "Copy the reply"}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
    </button>
  );
}

/** Reads the reply aloud, or stops it. */
function ListenButton({ state, onToggle }: { state: "idle" | "loading" | "playing"; onToggle: () => void }) {
  const label = state === "playing" ? "Stop reading aloud" : state === "loading" ? "Getting the reply read aloud…" : "Read aloud";
  return (
    <button
      type="button"
      className={`icon-button tiny${state === "idle" ? "" : " active"}`}
      aria-label={label}
      title={label}
      aria-pressed={state !== "idle"}
      onClick={onToggle}
    >
      {state === "playing" ? <StopIcon size={16} /> : <SpeakerIcon size={16} />}
    </button>
  );
}

/** A recording's length, as minutes and seconds. */
function formatSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A file's contents, or a recording's, as base64, for sending in the message's JSON. */
function base64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("The file couldn't be read."));
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
