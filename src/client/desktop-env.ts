/**
 * Absolute base for the plugin's own host transports — the HTTP routes
 * (`/sidebar/api/*`, `/sidebar/file`, `/sidebar/bundle/*`, …) and the
 * WebSockets (`/sidebar/ws/*`) resolve through the same source
 * (see `host-route-url.ts`).
 *
 * A desktop shell may serve the GUI from a custom scheme: the official Electron
 * shell uses `dsh-app://app/`, whose `location.host` is the literal string
 * `app`. Resolving a route against that origin produces `ws://app/...`, which
 * can never complete a DNS lookup — every socket the sidebar opens then fails
 * with a connection error. The shell publishes the Host's real base through
 * `__DSH_TRANSPORT__.streamBaseUrl`, the same source DSH's own downlink mux
 * resolves through (`stream-client.ts` in `@deepseek-ai/dsh-api-gateway`), so
 * prefer it and fall back to `document.baseURI` for ordinary http(s) pages —
 * that base is also what carries a reverse-proxy directory prefix.
 *
 * This is the ONE shell fact the client still reads: the shell's own desktop
 * stamps (`dsh-desktop-mode` / `-platform` / `-titlebar-inset`) and the
 * `ctx.desktopWindow` geometry contract used to feed a title-bar "strip" the
 * sidebar yielded at the top; that whole mechanism was removed (the plugin
 * draws no top chrome, so nothing ever consumed the value — see
 * docs/plans/2026-10-05-remove-titlebar-compat-strip.md).
 * @returns A URL string usable as the base argument of `new URL`, or '' when
 * neither source exists (non-DOM specs); route resolution then substitutes a
 * placeholder origin it never actually requests.
 */
export function hostTransportBase(): string {
  const transport = (globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }).__DSH_TRANSPORT__
  const base = transport?.streamBaseUrl
  if (base !== undefined && base !== '') return base
  return typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : ''
}

/**
 * Base for the plugin's own HTTP routes (`/sidebar/api/*`, `/sidebar/file`,
 * `/sidebar/bundle/*`, …): the PAGE's own base, not the injected transport
 * origin.
 *
 * The desktop shell makes those two different — page `dsh-app://app/`, injected
 * `streamBaseUrl` = the Host's `http://127.0.0.1:<port>`. HTTP must stay on the
 * page: the shell's `protocol.handle` forwards every non-static `dsh-app://app`
 * path to the Host same-origin (that is how `fetch('/sidebar/api/…')` reached it
 * before the prefix fix), while the Host's plugin routes answer no
 * `Access-Control-Allow-*` headers, so a cross-origin `fetch` to the injected
 * origin is blocked by the browser outright ("Failed to fetch"). WebSockets go
 * the other way round — see `hostTransportBase` and `host-route-url.ts`.
 *
 * `document.baseURI` carries a reverse-proxy directory prefix too, so one rule
 * covers both deployments.
 * @returns A URL string usable as the base argument of `new URL`; the transport
 * base only when no page base exists (specs, SSR).
 */
export function hostHttpBase(): string {
  const base = typeof document !== 'undefined' ? document.baseURI : undefined
  if (typeof base === 'string' && base !== '') return base
  return hostTransportBase()
}

/**
 * Whether a REAL browser tab can reach the plugin's http(s) routes — the gate
 * for "open in browser" (the editor header button and the file tree's PDF
 * row). False in the desktop shell: it serves the GUI from `dsh-app://app/`,
 * and Electron's main-window `setWindowOpenHandler` hands ONLY http(s) to
 * `shell.openExternal` while denying every other scheme, so a `dsh-app://`
 * popup is a silent no-op. Building plain `http://127.0.0.1:<port>` instead
 * does not help either: the shell process holds the auth cookie and the system
 * browser has none, so the new tab is rejected with 401.
 *
 * So the entries hide rather than ship a button that cannot do anything.
 * @returns true only when the page base is a real http(s) URL.
 */
export function canOpenInBrowser(): boolean {
  const base = hostHttpBase()
  if (base === '') return false
  try {
    const protocol = new URL(base).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

