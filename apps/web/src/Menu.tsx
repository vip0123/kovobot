import { type ReactNode, useEffect, useRef, useState } from "react";
import { MoreIcon } from "./Icons.tsx";

/** A "⋯" button that opens a short list of actions; a click outside or Escape closes it. */
export function Menu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const clickOutside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", clickOutside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", clickOutside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="menu" ref={menu}>
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreIcon />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
