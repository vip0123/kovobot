import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_OPENAI_KEY = "test-openai-key";

/** A 1x1 PNG, base64: the picture the fake image models make. */
export const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** What the API sent to the Responses API, as the fake received it. */
export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: Array<Record<string, unknown>>;
  stream?: boolean;
  store?: boolean;
  tools?: unknown[];
  include?: string[];
  reasoning?: { summary?: string; effort?: string };
  max_tool_calls?: number;
}

/**
 * A local stand-in for OpenAI's Responses API: a real HTTP server on
 * 127.0.0.1 that the official SDK talks to. It streams the reply it was told
 * to give, or fails with the status it was told to, and records every request.
 */
export class FakeOpenAI {
  readonly requests: ResponsesRequest[] = [];
  baseUrl = "";
  /** xAI reports each call's cost in ticks (10^10 per US dollar); null reports none, as OpenAI does. */
  costTicks: number | null = null;
  private next:
    | { kind: "reply"; deltas: string[] }
    | { kind: "break"; deltas: string[] }
    | { kind: "fail"; status: number } = { kind: "reply", deltas: ["Hello!"] };
  private gate: Promise<void> | undefined;
  private server: Server | undefined;
  private extraOutput: object[] = [];

  private thoughts: string[] = [];
  private sources: Array<{ url: string; title: string }> = [];

  private turns: QueuedTurn[] = [];

  /** The next reply's output also carries these items, such as a function_call or a computer_call. */
  addOutput(...items: object[]): void {
    this.extraOutput = items;
  }

  /**
   * The next requests get these answers, one each, in order: its text, any more output items,
   * and the pages it cites. Once they're used up, replies are as set by the other methods.
   */
  queueTurns(...turns: QueuedTurn[]): void {
    this.turns = turns;
  }

  /** The next reply first streams these pieces of its reasoning summary. */
  thinkFirst(...pieces: string[]): void {
    this.thoughts = pieces;
  }

  /** The next reply's text cites these web pages, as url_citation annotations. */
  citeSources(...sources: Array<{ url: string; title: string }>): void {
    this.sources = sources;
  }

  /** The next reply streams in these pieces. */
  replyWith(...deltas: string[]): void {
    this.next = { kind: "reply", deltas };
  }

  /** The next reply streams these pieces, then the model fails before finishing. */
  failMidStream(...deltas: string[]): void {
    this.next = { kind: "break", deltas };
  }

  /** The next request fails with this HTTP status. */
  failWith(status: number): void {
    this.next = { kind: "fail", status };
  }

  /** Holds the next reply back until the returned function is called. */
  holdNextReply(): () => void {
    let release!: () => void;
    this.gate = new Promise((resolve) => (release = resolve));
    return release;
  }

  /** Resolves once the fake has received this many requests in all. */
  async waitForRequests(count: number): Promise<void> {
    while (this.requests.length < count) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  /** Every request to the Image API, as the fake received it. */
  readonly imageRequests: Array<Record<string, unknown>> = [];
  /** What the Image API answers next: a picture, or a refusal under OpenAI's usage policy. */
  nextImage: "picture" | "refuse" = "picture";

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || (request.url !== "/v1/responses" && request.url !== "/v1/images/generations")) {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${FAKE_OPENAI_KEY}`) {
      sendJson(response, 401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error" } });
      return;
    }
    if (request.url === "/v1/images/generations") {
      this.imageRequests.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      if (this.nextImage === "refuse") {
        this.nextImage = "picture";
        sendJson(response, 400, {
          error: { message: "Your request was rejected by the safety system.", type: "image_generation_user_error", code: "moderation_blocked" },
        });
        return;
      }
      sendJson(response, 200, { created: 1, data: [{ b64_json: TINY_PNG }], usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 } });
      return;
    }
    const body = JSON.parse(await readBody(request)) as ResponsesRequest;
    this.requests.push(body);
    const queued = this.turns.shift();
    const next = queued ? { kind: "reply" as const, deltas: queued.text ? [queued.text] : [] } : this.next;
    const extraOutput = queued ? (queued.output ?? []) : this.extraOutput;
    this.extraOutput = [];
    const thoughts = this.thoughts;
    const sources = queued ? (queued.sources ?? []) : this.sources;
    // The pages its search found, as OpenAI lists them when asked: by address only.
    const found = (queued?.found ?? []).map((url) => ({ type: "url", url }));
    this.thoughts = [];
    this.sources = [];
    const gate = this.gate;
    this.gate = undefined;
    await gate;

    if (next.kind === "fail") {
      sendJson(response, next.status, { error: { message: "The server had an error.", type: "server_error" } });
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    const id = `resp_${randomUUID()}`;
    let sequence = 0;
    const send = (type: string, fields: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);

    send("response.created", { response: { id, object: "response", status: "in_progress", model: body.model, output: [] } });
    for (const delta of thoughts) {
      send("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta });
    }
    for (const delta of next.deltas) {
      send("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta, logprobs: [] });
    }
    if (next.kind === "break") {
      send("response.failed", {
        response: { id, object: "response", status: "failed", model: body.model, output: [], error: { code: "server_error", message: "The model failed." } },
      });
      response.end();
      return;
    }
    send("response.completed", {
      response: {
        id,
        object: "response",
        status: "completed",
        model: body.model,
        output: [
          ...(thoughts.length > 0
            ? [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: thoughts.join("") }], encrypted_content: "fake" }]
            : []),
          ...(sources.length > 0 || found.length > 0
            ? [{ type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "fake query", ...(found.length > 0 ? { sources: found } : {}) } }]
            : []),
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: next.deltas.join(""),
                annotations: sources.map((source) => ({ type: "url_citation", start_index: 0, end_index: 0, ...source })),
              },
            ],
          },
          ...extraOutput,
        ],
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 17,
          ...(this.costTicks === null ? {} : { cost_in_usd_ticks: this.costTicks }),
        },
      },
    });
    response.end();
  }
}

/** One answer the fake gives in turn: its text, more output items, the pages it cites, and the pages its search found. */
interface QueuedTurn {
  text?: string;
  output?: object[];
  sources?: Array<{ url: string; title: string }>;
  found?: string[];
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
