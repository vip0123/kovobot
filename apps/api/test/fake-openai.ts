import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_OPENAI_KEY = "test-openai-key";

/** What the API sent to the Responses API, as the fake received it. */
export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: Array<{ role: string; content: string }>;
  stream?: boolean;
  store?: boolean;
}

/**
 * A local stand-in for OpenAI's Responses API: a real HTTP server on
 * 127.0.0.1 that the official SDK talks to. It streams the reply it was told
 * to give, or fails with the status it was told to, and records every request.
 */
export class FakeOpenAI {
  readonly requests: ResponsesRequest[] = [];
  baseUrl = "";
  private next:
    | { kind: "reply"; deltas: string[] }
    | { kind: "break"; deltas: string[] }
    | { kind: "fail"; status: number } = { kind: "reply", deltas: ["Hello!"] };
  private gate: Promise<void> | undefined;
  private server: Server | undefined;

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

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${FAKE_OPENAI_KEY}`) {
      sendJson(response, 401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error" } });
      return;
    }
    const body = JSON.parse(await readBody(request)) as ResponsesRequest;
    this.requests.push(body);
    const next = this.next;
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
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: next.deltas.join(""), annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 17,
        },
      },
    });
    response.end();
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
