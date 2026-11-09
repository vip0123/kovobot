// Each Bot's monogram, in a colour that comes from its id, so it stays the same after a rename.

// Each keeps white text at WCAG AA contrast, in light and dark.
const COLOURS = ["#2f5bff", "#0e7490", "#0f7a43", "#b54708", "#be185d", "#4338ca", "#475467"];

export function BotAvatar({ id, name, size = "medium" }: { id: string; name: string; size?: "small" | "medium" | "large" }) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const colour = COLOURS[hash % COLOURS.length];
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span className={`avatar avatar-${size}`} style={{ background: colour }} aria-hidden="true">
      {initial}
    </span>
  );
}
