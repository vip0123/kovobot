// noVNC 1.7 is imported by its package name; its types still describe the older lib/ path.
declare module "@novnc/novnc" {
  export { default } from "@novnc/novnc/lib/rfb";
}
