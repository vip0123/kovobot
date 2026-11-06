import { type FormEvent, useState } from "react";

// Where the waitlist form posts: the API at VITE_APP_URL, or this origin in development.
const API_ORIGIN = (import.meta.env.VITE_APP_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_EMAIL = "Enter an email address so we can tell you when sign-up opens.";

export const FIRST_USES = [
  { id: "market-watch", label: "Market watch" },
  { id: "inbox-follow-ups", label: "Inbox follow-ups" },
  { id: "reports", label: "Reports from my tools" },
  { id: "build-and-test-apps", label: "Build and test apps" },
  { id: "something-else", label: "Something else" },
] as const;

export type FormPlace = "hero" | "cta";

/** The waitlist both forms share: one email, an optional first use, and where an error belongs. */
export function useWaitlist() {
  const [email, setEmail] = useState("");
  const [firstUse, setFirstUse] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<{ place: FormPlace; message: string } | null>(null);

  async function join(event: FormEvent, place: FormPlace) {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setError({ place, message: INVALID_EMAIL });
      return;
    }
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`${API_ORIGIN}/api/leads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, firstUse }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "Something went wrong. Try again.");
      }
      setJoined(true);
    } catch (caught) {
      const offline = caught instanceof TypeError;
      setError({
        place,
        message: offline ? "We couldn't reach Kovobot. Try again in a moment." : (caught as Error).message,
      });
    } finally {
      setSending(false);
    }
  }

  return {
    email,
    setEmail(value: string) {
      setEmail(value);
      setError(null);
    },
    firstUse,
    toggleFirstUse(id: string) {
      setFirstUse((current) => (current === id ? null : id));
    },
    sending,
    joined,
    errorFor: (place: FormPlace) => (error?.place === place ? error.message : null),
    join,
  };
}
