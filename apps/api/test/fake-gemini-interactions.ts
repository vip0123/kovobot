import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TINY_PNG } from "./fake-openai.ts";

export const FAKE_GEMINI_KEY = "test-gemini-key";

/** What the fake's next interaction gives: a picture, words instead of one, or an HTTP failure. */
type NextInteraction = { kind: "image" } | { kind: "words"; text: string } | { kind: "fail"; status: number };

/**
 * A local stand-in for Google's Interactions API, which its image, speech and transcription models
 * answer through: a real HTTP server on 127.0.0.1 that the official SDK talks to. It records every
 * request and answers with what it was told to.
 */
export class FakeGeminiInteractions {
  readonly requests: Array<{ path: string; apiKey: string | undefined; body: Record<string, unknown> }> = [];
  baseUrl = "";
  private next: NextInteraction = { kind: "image" };
  private server: Server | undefined;

  /** The next interaction answers with this; after it, with a picture again. */
  answerNext(next: NextInteraction): void {
    this.next = next;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const path = request.url ?? "";
    if (request.method !== "POST" || path !== "/v1beta/interactions") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const apiKey = request.headers["x-goog-api-key"] as string | undefined;
    this.requests.push({ path, apiKey, body });
    const next = this.next;
    this.next = { kind: "image" };
    if (apiKey !== FAKE_GEMINI_KEY) {
      sendJson(response, 400, { error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" } });
      return;
    }
    if (next.kind === "fail") {
      sendJson(response, next.status, { error: { code: next.status, message: "The model is overloaded.", status: "UNAVAILABLE" } });
      return;
    }
    const content = next.kind === "image" ? [{ type: "image", data: TINY_PNG, mime_type: "image/png" }] : [{ type: "text", text: next.text }];
    sendJson(response, 200, {
      id: `interaction-${this.requests.length}`,
      status: "completed",
      model: body.model,
      steps: [{ type: "model_output", content }],
      usage: { total_input_tokens: 12, total_output_tokens: 1290, total_tokens: 1302 },
    });
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
