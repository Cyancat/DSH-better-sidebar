/**
 * The file tree's "open in browser" hand-off for formats only the browser can
 * render itself. PDF is the first (and currently only) entry: the host's
 * `HOST_OWNED_EXTS` takes .pdf away from this plugin's editor entirely, so
 * there is no editor header to hang a button on — the row menu is the entry.
 *
 * The panel is Web-only: `canOpenInBrowser()` (desktop-env.ts) gates every
 * caller, because a desktop shell cannot hand a `dsh-app://` popup to the
 * system browser and has no cookie-bearing public URL to give it either.
 *
 * Kept as pure helpers (no React, no component state) so the file tree today
 * and any other row-menu surface later share one definition of "openable",
 * one URL builder, and one popup call — instead of drifting copies.
 */
import { mediaUrl, type SessionScope } from './api.ts'
import { extOf } from './paths.ts'

/** Types a browser can render natively; PDF is the first entry. */
export const BROWSER_OPENABLE_EXTS: ReadonlySet<string> = new Set(['pdf'])

/** Case-insensitive, dot-safe extension check. */
export function isBrowserOpenablePath(path: string): boolean {
  return BROWSER_OPENABLE_EXTS.has(extOf(path))
}

/** Authenticated inline media URL for a real browser tab (never a download:
 *  the browser's own PDF viewer is the point). */
export function browserOpenUrl(scope: SessionScope, path: string): string {
  return mediaUrl(scope, path)
}

/**
 * Open a real browser tab. `window.open` reports a popup-blocked refusal as
 * `null`, but `noopener` makes a successful open return `null` too, so the
 * return value cannot distinguish them — a known limitation shared with the
 * editor header's button; false only means the call itself threw.
 * @returns false when the caller should report the failure.
 */
export function openBrowserTab(url: string): boolean {
  try {
    window.open(url, '_blank', 'noopener')
    return true
  } catch {
    return false
  }
}
