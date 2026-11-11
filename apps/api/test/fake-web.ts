import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the web pages a Bot reads: a real HTTP server on 127.0.0.1 serving the
 * pages a test puts on it. It records every path asked for, and `onRequest` runs before each answer.
 */
export class FakeWeb {
  baseUrl = "";
  /** Every path asked for, in order. */
  readonly requested: string[] = [];
  /** Runs before each page is answered, as when a test moves its clock on while a page loads. */
  onRequest: (() => void) | null = null;
  private pages = new Map<string, { status: number; type: string; body: string }>();
  private server: Server | undefined;

  /** The address of a page on the fake web. */
  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** Serves `body` at `path`, as HTML unless another type is given. */
  page(path: string, body: string, options: { status?: number; type?: string } = {}): string {
    this.pages.set(path, { status: options.status ?? 200, type: options.type ?? "text/html; charset=utf-8", body });
    return this.url(path);
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  /** Whether an address is on the fake web. */
  serves(address: string): boolean {
    return this.baseUrl !== "" && address.startsWith(`${this.baseUrl}/`);
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const path = request.url ?? "/";
    this.requested.push(path);
    this.onRequest?.();
    const page = this.pages.get(path);
    if (!page) {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found.");
      return;
    }
    response.writeHead(page.status, { "content-type": page.type }).end(page.body);
  }
}
