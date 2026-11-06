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

  /** The next replies stream in these pieces. */
  replyWith(...deltas: string[]): void {
    this.deltas = deltas;
  }

  /** The next reply ends this way; see `Ending`. */
  endNextReply(ending: Ending): void {
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

/** Anthropic's Messages API, streamed: POST /v1/messages. */
export class FakeAnthropic extends FakeModelServer {
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
    let index = 0;
    if (fallback) {
      send("content_block_start", {
        index,
        content_block: { type: "fallback", from: { model: body.model }, to: { model: fallback } },
      });
      send("content_block_stop", { index: index++ });
    }
    send("content_block_start", { index, content_block: { type: "text", text: "" } });
    for (const text of this.deltas) send("content_block_delta", { index, delta: { type: "text_delta", text } });
    if (ending.kind === "cut-off") {
      response.end();
      return;
    }
    send("content_block_stop", { index });
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
    const stopReason = ending.kind === "stop" ? ending.reason : "end_turn";
    send("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage });
    send("message_stop", {});
    response.end();
  }
}

/** Google's Gemini API, streamed: POST /v1beta/models/{model}:streamGenerateContent?alt=sse. */
export class FakeGemini extends FakeModelServer {
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
    this.deltas.forEach((text, index) => {
      const last = index === this.deltas.length - 1;
      send({
        candidates: [
          { content: { parts: [{ text }], role: "model" }, index: 0, ...(last && finishReason ? { finishReason } : {}) },
        ],
        ...(last ? { usageMetadata } : {}),
      });
    });
    response.end();
  }
}

/** The OpenAI-compatible Chat Completions API (OpenRouter, local servers): POST /v1/chat/completions. */
export class FakeChatCompletions extends FakeModelServer {
  /** The cost the server reports with usage, in US dollars, as OpenRouter does; null reports none. */
  costUsd: number | null = null;

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
    for (const content of this.deltas) {
      send({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] });
    }
    if (ending.kind === "cut-off") {
      response.end();
      return;
    }
    const finishReason = ending.kind === "stop" ? ending.reason : "stop";
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
