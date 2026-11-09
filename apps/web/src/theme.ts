// Light or dark: the Customer's pick when they've made one, otherwise the system's.
// index.html applies a stored pick before the first paint, so the page never flashes.

export type Theme = "light" | "dark";

const STORAGE_KEY = "kovobot-theme";

export function currentTheme(): Theme {
  const picked = document.documentElement.dataset.theme;
  if (picked === "light" || picked === "dark") return picked;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function pickTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private windows may refuse storage; the pick still holds until the page closes.
  }
}
