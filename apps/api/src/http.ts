import type { Context, MiddlewareHandler } from "hono";

/** Every API error has this shape: a stable machine-readable code and a sentence for people. */
export function apiError(c: Context, status: 400 | 401 | 403 | 404, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/** The request's JSON object body, or {} when there is none or it isn't an object. */
export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Browsers send an Origin header with every write. A write from any origin but
 * the web app's is refused, whatever its content type, so a session cookie
 * can't be used from another website. Writes without an Origin come from
 * servers, such as payment webhooks, which never hold a Customer's cookie.
 */
export function sameOriginWrites(appUrl: string): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (!SAFE_METHODS.has(c.req.method) && origin !== undefined && origin !== appUrl) {
      return apiError(c, 403, "cross_site", "This request came from another website.");
    }
    await next();
  };
}
