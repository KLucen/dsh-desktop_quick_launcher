//#region src/client.d.ts
/**
 * dsh-desktop_quick_launcher — browser half.
 *
 * A small floating panel pinned to the bottom-right corner of the dsh web page:
 *
 *  - the icon button creates/refreshes the desktop icon and opens the details
 *    popover (instance info, the last launcher report, the last restart report,
 *    and the captured child tail);
 *  - the power button stops the host (custom confirm dialog); the restart button
 *    hands over to the host's detached helper and waits for the new instance
 *    before reloading the page back into the same session.
 *
 * Safety rules the UI mirrors from the host:
 *  - state-changing routes need the per-instance nonce fetched from /ping;
 *  - while a turn is open (`busy.generating`) both buttons are disabled and the
 *    panel offers "restart when idle" instead;
 *  - an override ("force") exists but is reachable only through a second,
 *    explicitly-worded confirmation.
 *
 * Zero client-SDK dependencies: plain fetch + react-dom, inline styles. The host
 * half enforces the loopback fence, the nonce, and the busy guard.
 */
declare const name = "dsh-desktop_quick_launcher";
/** No cordis services are required in the browser. */
declare const inject: string[];
/**
 * Mount the floating control once into document.body, then register the
 * settings card.
 * @param ctx - client root context (used only for the settings section).
 */
declare function apply(ctx?: unknown): void;
declare const _default: {
  name: string;
  inject: string[];
  apply: typeof apply;
};
//#endregion
export { apply, _default as default, inject, name };