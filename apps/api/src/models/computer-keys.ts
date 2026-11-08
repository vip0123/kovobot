// Each Model provider names keys its own way ("ENTER", "control", "Return"); the Computer
// agent takes xdotool's names. One map serves every Driver model.

const XDOTOOL_NAMES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "super",
  command: "super",
  meta: "super",
  super: "super",
  win: "super",
  capslock: "Caps_Lock",
};

/** One key in xdotool's naming: a known name mapped, F-keys and single characters kept. */
function xdotoolKey(name: string): string {
  const known = XDOTOOL_NAMES[name.toLowerCase()];
  if (known) return known;
  if (/^f([1-9]|1[0-2])$/i.test(name)) return name.toUpperCase();
  return name.length === 1 ? name.toLowerCase() : name;
}

/** A key combination, as separate names or one "a+b" string, in xdotool's "ctrl+shift+t" form. */
export function xdotoolKeys(keys: string | string[]): string {
  const names = Array.isArray(keys) ? keys : keys.split("+");
  return names
    .map((name) => name.trim())
    .filter(Boolean)
    .map(xdotoolKey)
    .join("+");
}
