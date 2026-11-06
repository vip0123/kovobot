import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A request a fake Model provider received. */
export interface ReceivedRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

/**
 * A local stand-in for one Model provider's API: a real HTTP server on
 * 127.0.0.1 that the provider's official SDK talks to. It streams the reply
 * it was told to give, and records every request.
 */
abstract class FakeModelServer {
  readonly requests: ReceivedRequest[] = [];
  baseUrl = "";
  protected deltas: string[] = ["Hello!"];
  private server: Server | undefined;

  /** The next replies stream in these pieces. */
  replyWith(...deltas: string[]): void {
    this.deltas = deltas;
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

  protected abstract respond(path: string, body: Record<string, unknown>, response: ServerResponse): void;

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const path = request.url ?? "";
    this.requests.push({ path, headers: request.headers, body });
    this.respond(path, body, response);
  }
}

/** Anthropic's Messages API, streamed: POST /v1/messages. */
export class FakeAnthropic extends FakeModelServer {
  protected respond(path: string, body: Record<string, unknown>, response: ServerResponse): void {
    if (!path.startsWith("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, fields: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    send("message_start", {
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 300, output_tokens: 1 },
      },
    });
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const text of this.deltas) send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } });
    send("message_stop", {});
    response.end();
  }
}

/** Google's Gemini API, streamed: POST /v1beta/models/{model}:streamGenerateContent?alt=sse. */
export class FakeGemini extends FakeModelServer {
  protected respond(path: string, _body: Record<string, unknown>, response: ServerResponse): void {
    if (!path.includes(":streamGenerateContent")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (chunk: object) => response.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
    this.deltas.forEach((text, index) => {
      const last = index === this.deltas.length - 1;
      send({
        candidates: [{ content: { parts: [{ text }], role: "model" }, index: 0, ...(last ? { finishReason: "STOP" } : {}) }],
        ...(last
          ? {
              usageMetadata: {
                promptTokenCount: 30,
                cachedContentTokenCount: 10,
                candidatesTokenCount: 6,
                thoughtsTokenCount: 4,
                totalTokenCount: 40,
              },
            }
          : {}),
      });
    });
    response.end();
  }
}

/** The OpenAI-compatible Chat Completions API (OpenRouter, local servers): POST /v1/chat/completions. */
export class FakeChatCompletions extends FakeModelServer {
  /** The cost the server reports with usage, in US dollars, as OpenRouter does; null reports none. */
  costUsd: number | null = null;

  protected respond(path: string, body: Record<string, unknown>, response: ServerResponse): void {
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
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    send({
      choices: [],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 9,
        total_tokens: 49,
        prompt_tokens_details: { cached_tokens: 16 },
        ...(this.costUsd === null ? {} : { cost: this.costUsd }),
      },
    });
    response.write("data: [DONE]\n\n");
    response.end();
  }
}
