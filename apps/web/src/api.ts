// The API lives on the same origin under /api, so the session cookie is first-party.

export interface Customer {
  id: string;
  email: string;
}

/** An error answer from the API: its machine-readable code and a sentence to show. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: { method?: "GET" | "POST"; json?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: init.method ?? "GET",
      headers: init.json === undefined ? {} : { "content-type": "application/json" },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
  } catch {
    throw new ApiError(0, "offline", "Can't reach Kovobot. Check your connection and try again.");
  }
  const body: unknown = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : undefined;
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(response.status, error?.code ?? "unknown", error?.message ?? "Something went wrong. Try again.");
  }
  return body as T;
}

export const api = {
  signInOptions: () => request<{ emailLink: boolean; google: boolean }>("/auth/options"),
  sendSignInLink: (email: string) => request<unknown>("/auth/email-link", { method: "POST", json: { email } }),
  confirmSignInLink: (token: string) =>
    request<{ customer: Customer }>("/auth/email-link/confirm", { method: "POST", json: { token } }),
  me: () => request<{ customer: Customer }>("/me"),
  signOut: () => request<unknown>("/auth/sign-out", { method: "POST" }),
};

/** Where "Sign in with Google" starts: a full-page visit, since Google takes over the page. */
export const GOOGLE_SIGN_IN_URL = "/api/auth/google";
