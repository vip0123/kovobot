import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A request a fake Model provider received. */
export interface ReceivedRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

/** How a fake's next reply ends. Replies after it finish normally again. */
export type Ending =
  | { kind: "finish" }
  /** The stream stops part-way: no end-of-reply signal ever arrives. */
  | { kind: "cut-off" }
  /** The Model provider stops the reply for this reason (a refusal, a safety block). */
  | { kind: "stop"; reason: string }
  /** Gemini blocks the prompt itself: no reply at all. */
  | { kind: "block-prompt"; reason: string }
  /** The model asked for declines, and this Claude model answers in its place (server-side fallback). */
  | { kind: "fall-back"; to: string }
  /** The request fails with this HTTP status. */
  | { kind: "fail"; status: number };

/**
 * A local stand-in for one Model provider's API: a real HTTP server on
 * 127.0.0.1 that the Model provider's official SDK talks to. It streams the reply
 * it was told to give, and records every request.
 */
abstract class FakeModelServer {
  readonly requests: ReceivedRequest[] = [];
  baseUrl = "";
  protected deltas: string[] = ["Hello!"];
  private ending: Ending = { kind: "finish" };
  private server: Server | undefined;
  private thoughts: string[] = [];
  private sources: FakeSource[] = [];
  /** The endings this Model provider's API can produce. */
  protected abstract readonly endings: ReadonlySet<Ending["kind"]>;

  /** The next replies stream in these pieces. */
  replyWith(...deltas: string[]): void {
    this.deltas = deltas;
  }

  /** The next reply first streams these pieces of the model's thinking, as the Model provider shows it. */
  thinkFirst(...pieces: string[]): void {
    this.thoughts = pieces;
  }

  /** The next reply cites these web pages, as the Model provider's web search does. */
  citeSources(...sources: FakeSource[]): void {
    this.sources = sources;
  }

  /** What the next reply thinks and cites; each holds for one reply. */
  protected takeExtras(): { thoughts: string[]; sources: FakeSource[] } {
    const extras = { thoughts: this.thoughts, sources: this.sources };
    this.thoughts = [];
    this.sources = [];
    return extras;
  }

  /** The next reply ends this way; see `Ending`. */
  endNextReply(ending: Ending): void {
    if (!this.endings.has(ending.kind)) throw new Error(`${this.constructor.name} can't end a reply with ${ending.kind}.`);
    this.ending = ending;
  }

  /** Starts listening; `pathPrefix` is added to `baseUrl` for SDKs that expect it there. */
  async start(pathPrefix = ""): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${pathPrefix}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  protected abstract respond(path: string, body: Record<string, unknown>, response: ServerResponse, ending: Ending): void;

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const path = request.url ?? "";
    this.requests.push({ path, headers: request.headers, body });
    const ending = this.ending;
    this.ending = { kind: "finish" };
    if (ending.kind === "fail") {
      response.writeHead(ending.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "api_error", message: "The fake failed, as asked." } }));
      return;
    }
    this.respond(path, body, response, ending);
  }
}

/** A web page a fake's web search found and the reply cites. */
export interface FakeSource {
  url: string;
  title: string;
}

/** A tool use the fake streams: one of our functions, or an action of the computer toolset. */
export interface FakeToolUse {
  name: string;
  input: object;
  toolset?: "computer";
}

/** Anthropic's Messages API, streamed: POST /v1/messages. */
export class FakeAnthropic extends FakeModelServer {
  protected readonly endings = new Set<Ending["kind"]>(["finish", "cut-off", "stop", "fall-back", "fail"]);
  private toolUses: FakeToolUse[] = [];

  /** The next reply ends by using these tools, in order, with stop_reason "tool_use". */
  useTools(...uses: FakeToolUse[]): void {
    this.toolUses = uses;
  }

  protected respond(path: string, body: Record<string, unknown>, response: ServerResponse, ending: Ending): void {
    if (!path.startsWith("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, fields: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    const fallback = ending.kind === "fall-back" ? ending.to : null;
    send("message_start", {
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        // A declined-before-output attempt is invisible here: the stream opens on the model that answers.
        model: fallback ?? body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 300, output_tokens: 1 },
      },
    });
    const { thoughts, sources } = this.takeExtras();
    let index = 0;
    if (fallback) {
      send("content_block_start", {
        index,
        content_block: { type: "fallback", from: { model: body.model }, to: { model: fallback } },
      });
      send("content_block_stop", { index: index++ });
    }
    if (thoughts.length > 0) {
      send("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const thinking of thoughts) send("content_block_delta", { index, delta: { type: "thinking_delta", thinking } });
      send("content_block_delta", { index, delta: { type: "signature_delta", signature: "fake-signature" } });
      send("content_block_stop", { index: index++ });
    }
    if (sources.length > 0) {
      // The web search server tool: its use, its results, then a reply that cites them.
      send("content_block_start", { index, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "fake query" }) } });
      send("content_block_stop", { index: index++ });
      send("content_block_start", {
        index,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: sources.map((source) => ({ type: "web_search_result", ...source, encrypted_content: "fake", page_age: null })),
        },
      });
      send("content_block_stop", { index: index++ });
    }
    send("content_block_start", { index, content_block: { type: "text", text: "" } });
    for (const text of this.deltas) send("content_block_delta", { index, delta: { type: "text_delta", text } });
    for (const source of sources) {
      send("content_block_delta", {
        index,
        delta: {
          type: "citations_delta",
          citation: { type: "web_search_result_location", ...source, cited_text: "cited", encrypted_index: "fake" },
        },
      });
    }
    if (ending.kind === "cut-off") {
      response.end();
      return;
    }
    send("content_block_stop", { index });
    const uses = this.toolUses;
    this.toolUses = [];
    uses.forEach((use, n) => {
      const at = index + 1 + n;
      send("content_block_start", {
        index: at,
        content_block: { type: "tool_use", id: `toolu_${n}`, name: use.name, input: {}, ...(use.toolset ? { toolset_name: use.toolset } : {}) },
      });
      send("content_block_delta", { index: at, delta: { type: "input_json_delta", partial_json: JSON.stringify(use.input) } });
      send("content_block_stop", { index: at });
    });
    const usage = {
      output_tokens: 7,
      // Each attempt, as Anthropic bills it: the declined one and the one that answered.
      ...(fallback
        ? {
            iterations: [
              { type: "message", model: body.model, input_tokens: 20, cache_creation_input_tokens: 400, cache_read_input_tokens: 0, output_tokens: 0, cache_creation: null },
              { type: "fallback_message", model: fallback, input_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 300, output_tokens: 7, cache_creation: null },
            ],
          }
        : {}),
    };
    const stopReason = ending.kind === "stop" ? ending.reason : uses.length > 0 ? "tool_use" : "end_turn";
    send("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage });
    send("message_stop", {});
    response.end();
  }
}

/** Google's Gemini API, streamed: POST /v1beta/models/{model}:streamGenerateContent?alt=sse. */
export class FakeGemini extends FakeModelServer {
  protected readonly endings = new Set<Ending["kind"]>(["finish", "cut-off", "stop", "block-prompt", "fail"]);
  private functionCalls: Array<{ name: string; args: object; id?: string }> = [];

  /** The next reply ends with these function calls: our functions, or the computer-use tool's. */
  callFunctions(...calls: Array<{ name: string; args: object; id?: string }>): void {
    this.functionCalls = calls;
  }

  protected respond(path: string, _body: Record<string, unknown>, response: ServerResponse, ending: Ending): void {
    if (!path.includes(":streamGenerateContent")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (chunk: object) => response.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
    const usageMetadata = {
      promptTokenCount: 30,
      cachedContentTokenCount: 10,
      candidatesTokenCount: 6,
      thoughtsTokenCount: 4,
      totalTokenCount: 40,
    };
    if (ending.kind === "block-prompt") {
      send({ promptFeedback: { blockReason: ending.reason }, usageMetadata });
      response.end();
      return;
    }
    const finishReason = ending.kind === "stop" ? ending.reason : ending.kind === "cut-off" ? null : "STOP";
    const calls = this.functionCalls;
    this.functionCalls = [];
    const { thoughts, sources } = this.takeExtras();
    for (const text of thoughts) send({ candidates: [{ content: { parts: [{ text, thought: true }], role: "model" }, index: 0 }] });
    // Grounding with Google Search: its sources, and the search suggestions Google asks apps to show.
    const groundingMetadata =
      sources.length > 0
        ? {
            webSearchQueries: ["fake query"],
            groundingChunks: sources.map((source) => ({ web: { uri: source.url, title: source.title } })),
            searchEntryPoint: { renderedContent: '<div class="fake-suggestions">fake query</div>' },
          }
        : undefined;
    this.deltas.forEach((text, index) => {
      const last = index === this.deltas.length - 1;
      const callParts = last ? calls.map((call) => ({ functionCall: call })) : [];
      send({
        candidates: [
          {
            content: { parts: [{ text }, ...callParts], role: "model" },
            index: 0,
            ...(last && finishReason ? { finishReason } : {}),
            ...(last && groundingMetadata ? { groundingMetadata } : {}),
          },
        ],
        ...(last ? { usageMetadata } : {}),
      });
    });
    response.end();
  }
}

/** The OpenAI-compatible Chat Completions API (OpenRouter, local servers): POST /v1/chat/completions. */
export class FakeChatCompletions extends FakeModelServer {
  protected readonly endings = new Set<Ending["kind"]>(["finish", "cut-off", "stop", "fail"]);
  /** The cost the server reports with usage, in US dollars, as OpenRouter does; null reports none. */
  costUsd: number | null = null;
  /** Where thinking streams: OpenRouter's `reasoning`, or `reasoning_content` as some local servers send it. */
  reasoningField: "reasoning" | "reasoning_content" = "reasoning";
  private toolCalls: Array<{ id: string; name: string; args: object }> = [];

  /** The next reply ends by calling these tools, their arguments streamed in two pieces each. */
  callTools(...calls: Array<{ id: string; name: string; args: object }>): void {
    this.toolCalls = calls;
  }

  protected respond(path: string, body: Record<string, unknown>, response: ServerResponse, ending: Ending): void {
    if (path !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (chunk: object) =>
      response.write(
        `data: ${JSON.stringify({ id: "gen-fake", object: "chat.completion.chunk", created: 0, model: body.model, ...chunk })}\n\n`,
      );
    const { thoughts, sources } = this.takeExtras();
    for (const thought of thoughts) {
      send({ choices: [{ index: 0, delta: { role: "assistant", [this.reasoningField]: thought }, finish_reason: null }] });
    }
    for (const content of this.deltas) {
      send({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] });
    }
    if (sources.length > 0) {
      // OpenRouter's web plugin: the sources arrive as url_citation annotations.
      const annotations = sources.map((source) => ({ type: "url_citation", url_citation: { ...source, start_index: 0, end_index: 0 } }));
      send({ choices: [{ index: 0, delta: { annotations }, finish_reason: null }] });
    }
    if (ending.kind === "cut-off") {
      response.end();
      return;
    }
    const calls = this.toolCalls;
    this.toolCalls = [];
    calls.forEach((call, index) => {
      const json = JSON.stringify(call.args);
      const half = Math.floor(json.length / 2);
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: json.slice(0, half) } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: json.slice(half) } }] }, finish_reason: null }] });
    });
    const finishReason = ending.kind === "stop" ? ending.reason : calls.length > 0 ? "tool_calls" : "stop";
    send({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
    send({
      choices: [],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 9,
        total_tokens: 49,
        prompt_tokens_details: { cached_tokens: 16, cache_write_tokens: 8 },
        ...(this.costUsd === null ? {} : { cost: this.costUsd }),
      },
    });
    response.write("data: [DONE]\n\n");
    response.end();
  }
}
