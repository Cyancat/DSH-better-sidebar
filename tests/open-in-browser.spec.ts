/**
 * The shared "open in browser" vocabulary used by the file tree's PDF row
 * (and, later, any other row-menu surface): the extension allow-list, the
 * inline media URL, and the popup call.
 *
 * The two properties that matter beyond the obvious:
 * - the URL must be the SAME page-prefix-safe media URL the rest of the
 *   plugin builds (`mediaUrl` → `hostRouteUrl`), never a hand-pasted origin —
 *   a reverse proxy serves the GUI under a directory prefix;
 * - `?download=1` is NOT used: the point is the browser's own inline viewer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
// First import: the helper's modules probe document/window at call time.
import './browser-globals.ts'
import {
  BROWSER_OPENABLE_EXTS,
  browserOpenUrl,
  isBrowserOpenablePath,
  openBrowserTab,
} from '../src/client/open-in-browser.ts'
import type { SessionScope } from '../src/client/api.ts'

const scope: SessionScope = { sessionId: 's1', cwd: '/ws' }

/** Replace window.open for one case (browser-globals' window is a plain stub). */
function withWindowOpen(open: ((...args: unknown[]) => unknown) | undefined, body: () => void): void {
  const win = globalThis.window as unknown as { open?: unknown }
  const previous = win.open
  win.open = open
  try {
    body()
  } finally {
    win.open = previous
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
})

describe('isBrowserOpenablePath', () => {
  it('accepts PDF only, case-insensitively', () => {
    expect(isBrowserOpenablePath('/ws/manual.pdf')).toBe(true)
    expect(isBrowserOpenablePath('/ws/MANUAL.PDF')).toBe(true)
    expect(isBrowserOpenablePath('/ws/a.PdF')).toBe(true)
    expect(BROWSER_OPENABLE_EXTS.has('pdf')).toBe(true)
  })

  it('rejects other files, lookalike extensions and extensionless names', () => {
    for (const path of ['/ws/a.ts', '/ws/a.pdfx', '/ws/a.pdf.txt', '/ws/README', '/ws/pdf', '/ws/xhtml']) {
      expect(isBrowserOpenablePath(path), path).toBe(false)
    }
    // A dot in a DIRECTORY name is not an extension.
    expect(isBrowserOpenablePath('/ws/dir.pdf/file')).toBe(false)
  })
})

describe('browserOpenUrl', () => {
  it('is the page-prefix-safe inline media URL (never a download)', () => {
    const document = globalThis.document as { baseURI?: string }
    const previous = document.baseURI
    Object.defineProperty(document, 'baseURI', {
      value: 'https://host.example.test/dataops/proxy/3080/',
      configurable: true,
      writable: true,
    })
    try {
      const url = browserOpenUrl(scope, '/ws/manual.pdf')
      expect(url).toBe(
        'https://host.example.test/dataops/proxy/3080/sidebar/file'
        + '?sessionId=s1&path=%2Fws%2Fmanual.pdf&cwd=%2Fws',
      )
      expect(url).not.toContain('download=1')
    } finally {
      Object.defineProperty(document, 'baseURI', { value: previous, configurable: true, writable: true })
    }
  })

  it('resolves a relative path against the session cwd', () => {
    expect(browserOpenUrl(scope, 'docs/manual.pdf')).toContain('path=%2Fws%2Fdocs%2Fmanual.pdf')
  })
})

describe('openBrowserTab', () => {
  it('opens a real tab with _blank + noopener and reports success', () => {
    const open = vi.fn(() => null)
    withWindowOpen(open, () => {
      expect(openBrowserTab('https://host.example.test/pdf')).toBe(true)
    })
    expect(open).toHaveBeenCalledWith('https://host.example.test/pdf', '_blank', 'noopener')
  })

  it('reports false only when window.open throws (a refusal can look like null)', () => {
    withWindowOpen(() => { throw new Error('blocked') }, () => {
      expect(openBrowserTab('https://host.example.test/pdf')).toBe(false)
    })
    // `noopener` makes a BLOCKED popup and a successful one both return null,
    // so that shape must still count as "launched" (no false failure strip).
    withWindowOpen(() => null, () => {
      expect(openBrowserTab('https://host.example.test/pdf')).toBe(true)
    })
  })
})
