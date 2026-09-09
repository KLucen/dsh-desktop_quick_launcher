//#region src/client.d.ts
/**
 * dsh-desktop_quick_launcher — browser half.
 *
 * A small circular power button pinned to the bottom-right corner of the dsh
 * web page. Clicking it opens a custom confirmation dialog (instead of the
 * native confirm); confirming POSTs /api/dsh-desktop_quick_launcher/shutdown
 * and the host process exits gracefully. A second small button creates or
 * refreshes the desktop launcher icon (POST /create) with an inline toast.
 *
 * Zero client-SDK dependencies: plain fetch + react-dom, inline styles. The
 * Host half enforces the loopback-only fence on both routes.
 */
declare const name = "dsh-desktop_quick_launcher";
/** No cordis services are required in the browser. */
declare const inject: string[];
/**
 * Mount the floating control once into document.body.
 * @param _ctx - client root context (unused; kept for loader compatibility).
 */
declare function apply(_ctx: unknown): void;
declare const _default: {
  name: string;
  inject: string[];
  apply: typeof apply;
};
//#endregion
export { apply, _default as default, inject, name };