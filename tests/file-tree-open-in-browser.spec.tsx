/**
 * The file tree's "open in browser" row: a PDF-only, read-only action that
 * hands the file to a REAL browser tab through the inline media route.
 *
 * PDF is the case, not an example: `HOST_OWNED_EXTS` gives .pdf to the host's
 * document preview, so the file never reaches this plugin's EditorHost and the
 * editor header's `browserUrl` button cannot cover it. The row menu is the
 * entry. It must appear ONLY for PDF files, be hidden in the desktop shell
 * (see `canOpenInBrowser`), open the EXACT `mediaUrl()` URL with `_blank` +
 * `noopener`, and close nothing (the preview tab belongs to the host).
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

beforeAll(() => {
  // vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

/** The one URL shape the mock media route answers; asserted verbatim. */
const mediaUrlOf = (scope: { sessionId: string }, path: string): string =>
  `http://host.test/sidebar/file?sessionId=${scope.sessionId}&path=${encodeURIComponent(path)}`

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({
        path,
        entries: [
          { name: 'sub', path: '/tmp/sub', isDir: true },
          { name: 'report.pdf', path: '/tmp/report.pdf', isDir: false },
          { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
          { name: 'paper.txt', path: '/tmp/paper.txt', isDir: false },
        ],
        truncated: false,
      })),
    }),
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file?download=1',
  // The factory runs hoisted, so this cannot close over mediaUrlOf: spell the
  // same expression here and keep mediaUrlOf for the assertion below.
  mediaUrl: (scope: { sessionId: string }, path: string) =>
    `http://host.test/sidebar/file?sessionId=${scope.sessionId}&path=${encodeURIComponent(path)}`,
  isOutsideWorkspaceMessage: () => false,
}))

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    await Promise.resolve()
    await Promise.resolve()
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** The row whose label text matches (rows are role="button" divs). */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** Open one row's context menu. */
async function openMenu(container: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    rowByName(container, name).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }),
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .map(item => item.textContent?.trim() ?? '')
}

function clickMenuitem(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(el => el.textContent?.trim() === label)
  if (item === undefined) throw new Error(`menuitem not found: ${label}`)
  act(() => { item.click() })
}

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
})

describe('FileTree open-in-browser row', () => {
  it('offers the PDF row and opens the exact media URL in a new tab', async () => {
    harness = await mountTree()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      await openMenu(harness.container, 'report.pdf')
      expect(menuLabels()).toContain('Open in browser')
      clickMenuitem('Open in browser')
      expect(open).toHaveBeenCalledTimes(1)
      expect(open).toHaveBeenCalledWith(
        mediaUrlOf({ sessionId: 's1' }, '/tmp/report.pdf'),
        '_blank',
        'noopener',
      )
    } finally {
      open.mockRestore()
    }
  })

  it('does not offer the row for ordinary files or directories', async () => {
    harness = await mountTree()
    for (const name of ['a.ts', 'paper.txt', 'sub']) {
      await openMenu(harness.container, name)
      expect(menuLabels(), name).not.toContain('Open in browser')
      // Close the menu before opening the next one.
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    }
  })

  it('hides the row in the desktop shell (dsh-app:// cannot reach the system browser)', async () => {
    harness = await mountTree()
    const document = globalThis.document as { baseURI?: string }
    const previous = document.baseURI
    Object.defineProperty(document, 'baseURI', { value: 'dsh-app://app/', configurable: true, writable: true })
    try {
      await openMenu(harness.container, 'report.pdf')
      // The PDF row still gets its normal menu; only the browser action hides.
      expect(menuLabels()).toContain('Download')
      expect(menuLabels()).not.toContain('Open in browser')
    } finally {
      Object.defineProperty(document, 'baseURI', { value: previous, configurable: true, writable: true })
    }
  })
})
