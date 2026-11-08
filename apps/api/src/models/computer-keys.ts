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

/** Punctuation keys, which xdotool names by keysym. */
const PUNCTUATION: Record<string, string> = {
  "/": "slash",
  "\\": "backslash",
  ".": "period",
  ",": "comma",
  "-": "minus",
  "=": "equal",
  "+": "plus",
  ";": "semicolon",
  "'": "apostrophe",
  "`": "grave",
  "[": "bracketleft",
  "]": "bracketright",
  " ": "space",
};

/**
 * One key in xdotool's naming: a known name or punctuation mapped, F-keys kept. A lone
 * letter keeps its case ("A" types a capital); in a combination it names the key ("ctrl+a").
 */
function xdotoolKey(name: string, inCombination: boolean): string {
  if (PUNCTUATION[name]) return PUNCTUATION[name];
  const known = XDOTOOL_NAMES[name.toLowerCase()];
  if (known) return known;
  if (/^f([1-9]|1[0-2])$/i.test(name)) return name.toUpperCase();
  return name.length === 1 && inCombination ? name.toLowerCase() : name;
}

/** A key combination, as separate names or one "a+b" string, in xdotool's "ctrl+shift+t" form. */
export function xdotoolKeys(keys: string | string[]): string {
  if (keys === "+") return "plus";
  // "ctrl++" is ctrl and the plus key: a "+" right after another one is the key itself.
  const names = Array.isArray(keys) ? keys : keys.split(/(?<!\+)\+/).map((name) => name || "+");
  const kept = names.map((name) => (name === " " ? name : name.trim())).filter(Boolean);
  return kept.map((name) => xdotoolKey(name, kept.length > 1)).join("+");
}
