import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TINY_PNG } from "./fake-openai.ts";

export const FAKE_GEMINI_KEY = "test-gemini-key";

/** What the fake's next interaction gives, when told: words, or an HTTP failure. */
type NextInteraction = { kind: "words"; text: string } | { kind: "fail"; status: number };

/** A WAV file of a moment of silence: what the fake speech model says. */
export const TINY_WAV = (() => {
  const samples = Buffer.alloc(480);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
})();

/**
 * A local stand-in for Google's Interactions API, which its image, speech and transcription models
 * answer through: a real HTTP server on 127.0.0.1 that the official SDK talks to. It records every
 * request and answers with what it was told to.
 */
export class FakeGeminiInteractions {
  readonly requests: Array<{ path: string; apiKey: string | undefined; body: Record<string, unknown> }> = [];
  baseUrl = "";
  /** What the transcription model hears in a recording. */
  transcript = "Two loaves of rye, please.";
  private next: NextInteraction | null = null;
  private server: Server | undefined;

  /**
   * The next interaction answers with this. Otherwise it answers as asked: speech for a request
   * for audio, the transcript for a recording, and a picture for anything else.
   */
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
    this.next = null;
    if (apiKey !== FAKE_GEMINI_KEY) {
      sendJson(response, 400, { error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" } });
      return;
    }
    if (next?.kind === "fail") {
      sendJson(response, next.status, { error: { code: next.status, message: "The model is overloaded.", status: "UNAVAILABLE" } });
      return;
    }
    const asksForAudio = (body.response_format as { type?: string } | undefined)?.type === "audio";
    const hearsAudio = Array.isArray(body.input) && body.input.some((part) => (part as { type?: string }).type === "audio");
    const content = next
      ? [{ type: "text", text: next.text }]
      : asksForAudio
        ? [{ type: "audio", data: TINY_WAV.toString("base64"), mime_type: "audio/wav" }]
        : hearsAudio
          ? [{ type: "text", text: this.transcript }]
          : [{ type: "image", data: TINY_PNG, mime_type: "image/png" }];
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
