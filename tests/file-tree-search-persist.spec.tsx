/**
 * The files panel's search surface and level-cache life-cycle:
 *
 * - Typing a query parks the tree (`hidden`) instead of unmounting it, so
 *   clearing the box restores the SAME level cache — `fs.tree` is not called
 *   again (the old conditional render dropped the tree and refetched the
 *   whole visible set on every query change).
 * - The refresh affordance wipes the cache and reloads concurrently, and a
 *   response from the previous generation is DROPPED even when it lands last.
 * - A level the host truncated says so instead of silently showing a partial
 *   directory.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'
import type { OpenInApp } from '../src/client/open-in-app.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the panel's copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

interface Listing {
  path: string
  entries: { name: string; path: string; isDir: boolean }[]
  truncated: boolean
}

/** The default host answer: one file at /tmp. */
function defaultListing(path: string): Listing {
  return { path, entries: [{ name: 'a.ts', path: '/tmp/a.ts', isDir: false }], truncated: false }
}

const { fsTrees, fsSearch } = vi.hoisted(() => ({
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => defaultListing(path)) })),
  fsSearch: vi.fn(async (): Promise<{ matches: string[]; dirs: string[]; truncated: boolean }> =>
    ({ matches: ['a.ts'], dirs: [], truncated: false })),
}))

/** The one URL shape the mocked inline media route answers; asserted verbatim. */
const mediaUrlOf = (scope: { sessionId: string }, path: string): string =>
  `http://host.test/sidebar/file?sessionId=${scope.sessionId}&path=${encodeURIComponent(path)}`

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    fsSearch,
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain.
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  // The PDF menu row builds an inline media URL; the hoisted factory cannot
  // close over mediaUrlOf, so the same expression is spelled here.
  mediaUrl: (scope: { sessionId: string }, path: string) =>
    `http://host.test/sidebar/file?sessionId=${scope.sessionId}&path=${encodeURIComponent(path)}`,
  isOutsideWorkspaceMessage: () => false,
}))

/** The host's open-in-app handle, present only in the tests that need it. */
function fakeOpenInApp(overrides: Partial<OpenInApp> = {}): OpenInApp {
  return {
    available: () => true,
    probe: async () => true,
    directoryApps: async () => [],
    fileApps: async () => [],
    open: async () => true,
    reveal: async () => true,
    ...overrides,
  }
}

interface Harness {
  container: HTMLDivElement
  /** Re-render with the same props plus overrides (visibility changes). */
  rerender: (overrides: Partial<ComponentProps<typeof TreePanel>>) => void
  unmount: () => void
}

function mountPanel(overrides: Partial<ComponentProps<typeof TreePanel>> = {}): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  let props: ComponentProps<typeof TreePanel> = {
    sessionId: 's1',
    cwd: '/tmp',
    expanded: [],
    revealed: [],
    onToggle: () => {},
    onOpenFile: () => {},
    onReferenceFile: () => {},
    ...overrides,
  }
  act(() => { root.render(createElement(TreePanel, props)) })
  return {
    container,
    rerender: (next) => {
      props = { ...props, ...next }
      act(() => { root.render(createElement(TreePanel, props)) })
    },
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/**
 * The tree surface: the body that carries row-name spans (the search results
 * panel is a body too, but its rows are plain buttons with no name span).
 * Finding it while parked is itself the "still mounted" probe.
 */
function treeBody(container: HTMLElement): HTMLElement {
  const body = [...container.querySelectorAll<HTMLElement>('div[class*="explorerBody"]')]
    .find(el => el.querySelector('[class*="explorerName"]') !== null)
  if (body === undefined) throw new Error('tree body not mounted')
  return body
}

function resultsBody(container: HTMLElement): HTMLElement {
  const tree = treeBody(container)
  const body = [...container.querySelectorAll<HTMLElement>('div[class*="explorerBody"]')]
    .find(el => el !== tree)
  if (body === undefined) throw new Error('results body not mounted')
  return body
}

/** The search rows, in list order (the tree's own rows are not buttons here). */
function resultRows(container: HTMLElement): HTMLButtonElement[] {
  return [...resultsBody(container).querySelectorAll<HTMLButtonElement>('button[class*="editorSearchResult"]')]
}

/** Type a query the React way and let the 300ms debounce elapse. */
async function search(container: HTMLElement, query: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[class*="editorSearchInput"]')!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { await new Promise<void>(resolve => { window.setTimeout(resolve, 350) }) })
}

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  fsTrees.mockReset()
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => defaultListing(path)) }))
  fsSearch.mockReset()
  fsSearch.mockImplementation(async () => ({ matches: ['a.ts'], dirs: [], truncated: false }))
})

describe('TreePanel search keeps the tree mounted', () => {
  it('parks the tree instead of unmounting it, so clearing the query keeps the level cache', async () => {
    harness = mountPanel()
    await act(async () => {})
    expect(fsTrees).toHaveBeenCalledTimes(1)
    expect(treeBody(harness.container).hasAttribute('hidden')).toBe(false)
    expect(harness.container.textContent).toContain('a.ts')

    await search(harness.container, 'a')
    expect(fsSearch).toHaveBeenCalledTimes(1)
    // The tree is still in the document — just parked.
    expect(treeBody(harness.container).hasAttribute('hidden')).toBe(true)
    expect(resultsBody(harness.container).hasAttribute('hidden')).toBe(false)
    expect(resultsBody(harness.container).textContent).toContain('a.ts')

    await search(harness.container, '')
    expect(treeBody(harness.container).hasAttribute('hidden')).toBe(false)
    expect(resultsBody(harness.container).hasAttribute('hidden')).toBe(true)
    // No second listing: the cache (and the expansion state) survived.
    expect(fsTrees).toHaveBeenCalledTimes(1)
  })
})

describe('TreePanel refresh and truncated levels', () => {
  it('drops a level response that lands after the cache was wiped', async () => {
    // The FIRST listing never settles until the test resolves it; the refresh
    // click starts the second one, which answers immediately.
    let resolveStale: (result: { levels: Listing[] }) => void = () => {}
    fsTrees.mockImplementationOnce(async () => await new Promise<{ levels: Listing[] }>(resolve => { resolveStale = resolve }))
    harness = mountPanel()
    await act(async () => {})
    // The pending level shows nothing yet (its rows are not known).
    expect(harness.container.textContent).not.toContain('a.ts')

    // Manual refresh: cache wiped, new generation, concurrent re-list.
    const refresh = harness.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!
    await act(async () => {
      refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fsTrees).toHaveBeenCalledTimes(2)
    expect(harness.container.textContent).toContain('a.ts')

    // The stale first answer arrives LAST and must be discarded.
    await act(async () => {
      resolveStale({ levels: [{ path: '/tmp', entries: [{ name: 'stale.ts', path: '/tmp/stale.ts', isDir: false }], truncated: false }] })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(harness.container.textContent).not.toContain('stale.ts')
    expect(harness.container.textContent).toContain('a.ts')
  })

  it('surfaces a truncated level instead of hiding it', async () => {
    fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({ path, entries: [{ name: 'a.ts', path: '/tmp/a.ts', isDir: false }], truncated: true })),
    }))
    harness = mountPanel()
    await act(async () => {})
    const notice = [...harness.container.querySelectorAll<HTMLElement>('[data-kind="hint"]')]
      .find(el => el.textContent?.includes('too many entries'))
    expect(notice).toBeDefined()
  })
})

describe('TreePanel directory hits navigate instead of opening', () => {
  it('expands a directory hit in the tree and never asks to open it as a file', async () => {
    fsSearch.mockResolvedValue({ matches: ['src', 'src/a.ts'], dirs: ['src'], truncated: false })
    const onToggle = vi.fn()
    const onOpenFile = vi.fn()
    harness = mountPanel({ onToggle, onOpenFile })
    await act(async () => {})
    await search(harness.container, 'src')

    const dirRow = resultRows(harness.container).find(row => row.textContent === 'src')!
    expect(dirRow.getAttribute('data-dsh-search-dir')).toBe('true')
    expect(resultRows(harness.container).find(row => row.textContent === 'src/a.ts')!
      .getAttribute('data-dsh-search-dir')).toBeNull()

    await act(async () => { dirRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // `fs.read` refuses a directory, so this row navigates instead of opening.
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(onToggle).toHaveBeenCalledWith('/tmp/src')
    // The query is cleared, so the tree (expanded at src) is what shows next.
    expect(harness.container.querySelector<HTMLInputElement>('input[class*="editorSearchInput"]')!.value).toBe('')
    expect(resultsBody(harness.container).hasAttribute('hidden')).toBe(true)
    expect(treeBody(harness.container).hasAttribute('hidden')).toBe(false)
  })

  it('expands every ancestor of a nested hit, but only collapsed ones', async () => {
    fsSearch.mockResolvedValue({ matches: ['src/deep', 'src/deep/a.ts'], dirs: ['src/deep'], truncated: false })
    const onToggle = vi.fn()
    harness = mountPanel({ cwd: '/w/app', expanded: ['/w/app/src'], onToggle })
    await act(async () => {})
    await search(harness.container, 'deep')

    const dirRow = resultRows(harness.container).find(row => row.textContent === 'src/deep')!
    await act(async () => { dirRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // /w/app is the explorer root and /w/app/src is already open: only the hit
    // itself is toggled (a repeat toggle would COLLAPSE an open ancestor).
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('/w/app/src/deep')
  })

  it('still opens a file hit, leaving the expansion state untouched', async () => {
    fsSearch.mockResolvedValue({ matches: ['src', 'src/a.ts'], dirs: ['src'], truncated: false })
    const onToggle = vi.fn()
    const onOpenFile = vi.fn()
    harness = mountPanel({ onToggle, onOpenFile })
    await act(async () => {})
    await search(harness.container, 'src')

    const fileRow = resultRows(harness.container).find(row => row.textContent === 'src/a.ts')!
    await act(async () => { fileRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onOpenFile).toHaveBeenCalledWith('/tmp/src/a.ts')
    expect(onToggle).not.toHaveBeenCalled()
    // A file open keeps the results list up (only a navigation clears it).
    expect(resultsBody(harness.container).hasAttribute('hidden')).toBe(false)
  })

  // #879's direct-open branch can hand the list a DIRECTORY outside the cwd
  // (a pasted absolute path). The tree is cwd-rooted, so there is nothing to
  // expand: the row must clear the query WITHOUT toggling — `ancestorDirs`
  // would otherwise synthesize cwd-length prefixes of the foreign path that
  // match no tree row and persist as junk `expanded` entries.
  it('clears the query for a directory hit outside the cwd without toggling anything', async () => {
    fsSearch.mockResolvedValue({ matches: ['/elsewhere/records'], dirs: ['/elsewhere/records'], truncated: false })
    const onToggle = vi.fn()
    harness = mountPanel({ onToggle })
    await act(async () => {})
    await search(harness.container, '/elsewhere/records')

    const dirRow = resultRows(harness.container).find(row => row.textContent === '/elsewhere/records')!
    expect(dirRow.getAttribute('data-dsh-search-dir')).toBe('true')
    await act(async () => { dirRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onToggle).not.toHaveBeenCalled()
    expect(harness.container.querySelector<HTMLInputElement>('input[class*="editorSearchInput"]')!.value).toBe('')
  })
})

describe('TreePanel search result context menu', () => {
  function menuLabels(): string[] {
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .map(item => item.textContent?.trim() ?? '')
  }

  function menuitem(label: string): HTMLElement {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(el => el.textContent?.trim() === label)
    if (item === undefined) throw new Error(`menuitem not found: ${label}; menu: ${menuLabels().join(' | ')}`)
    return item
  }

  async function openMenu(row: HTMLElement): Promise<void> {
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 24, clientY: 36,
      }))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function clickMenuitem(label: string): Promise<void> {
    await act(async () => {
      menuitem(label).click()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  function rowByText(container: HTMLElement, text: string): HTMLButtonElement {
    const row = resultRows(container).find(candidate => candidate.textContent === text)
    if (row === undefined) throw new Error(`search row not found: ${text}`)
    return row
  }

  it('offers the read-only file actions (and none of the tree’s mutations)', async () => {
    fsSearch.mockResolvedValue({ matches: ['a.ts'], dirs: [], truncated: false })
    const onOpenFileNewTab = vi.fn()
    const onOpenFileSide = vi.fn()
    harness = mountPanel({ openInApp: fakeOpenInApp(), onOpenFileNewTab, onOpenFileSide })
    await act(async () => {})
    await search(harness.container, 'a')

    await openMenu(rowByText(harness.container, 'a.ts'))
    expect(menuLabels()).toEqual([
      'Open',
      'Open in New Tab',
      'Open to the Side',
      'Download',
      'Reveal in File Manager',
      'Reveal in Tree',
      'Copy relative path',
      'Copy absolute path',
    ])
    // A flat search result is not the tree's selection: no mutating rows.
    for (const forbidden of ['Rename', 'Delete', 'Upload here', 'New folder', 'New file', 'Zip and download']) {
      expect(menuLabels(), forbidden).not.toContain(forbidden)
    }
  })

  it('opens the file hit through the same callback as a left click', async () => {
    fsSearch.mockResolvedValue({ matches: ['a.ts'], dirs: [], truncated: false })
    const onOpenFile = vi.fn()
    harness = mountPanel({ onOpenFile })
    await act(async () => {})
    await search(harness.container, 'a')

    await openMenu(rowByText(harness.container, 'a.ts'))
    await clickMenuitem('Open')
    expect(onOpenFile).toHaveBeenCalledWith('/tmp/a.ts')
    // Selecting a row closes the menu.
    expect(menuLabels()).toEqual([])
  })

  it('offers a directory hit only the reveal / copy actions, never the file ones', async () => {
    fsSearch.mockResolvedValue({ matches: ['src'], dirs: ['src'], truncated: false })
    harness = mountPanel({ openInApp: fakeOpenInApp(), onOpenFileNewTab: vi.fn(), onOpenFileSide: vi.fn() })
    await act(async () => {})
    await search(harness.container, 'src')

    await openMenu(rowByText(harness.container, 'src'))
    expect(menuLabels()).toEqual([
      'Reveal in Tree',
      'Reveal in File Manager',
      'Copy relative path',
      'Copy absolute path',
    ])
    for (const forbidden of ['Open', 'Open in New Tab', 'Open to the Side', 'Download', 'Open in browser']) {
      expect(menuLabels(), forbidden).not.toContain(forbidden)
    }
  })

  it('reveals a file hit by expanding its ancestors and clearing the query', async () => {
    fsSearch.mockResolvedValue({ matches: ['src/a.ts'], dirs: [], truncated: false })
    const onToggle = vi.fn()
    harness = mountPanel({ cwd: '/tmp', expanded: [], onToggle })
    await act(async () => {})
    await search(harness.container, 'src')

    await openMenu(rowByText(harness.container, 'src/a.ts'))
    await clickMenuitem('Reveal in Tree')
    expect(onToggle).toHaveBeenCalledWith('/tmp/src')
    expect(harness.container.querySelector<HTMLInputElement>('input[class*="editorSearchInput"]')!.value).toBe('')
    expect(resultsBody(harness.container).hasAttribute('hidden')).toBe(true)
  })

  it('offers the PDF browser row and opens the exact inline media URL', async () => {
    fsSearch.mockResolvedValue({ matches: ['manual.pdf'], dirs: [], truncated: false })
    harness = mountPanel()
    await act(async () => {})
    await search(harness.container, 'manual')

    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      await openMenu(rowByText(harness.container, 'manual.pdf'))
      expect(menuLabels()).toContain('Open in browser')
      await clickMenuitem('Open in browser')
      expect(open).toHaveBeenCalledTimes(1)
      expect(open).toHaveBeenCalledWith(
        mediaUrlOf({ sessionId: 's1' }, '/tmp/manual.pdf'),
        '_blank',
        'noopener',
      )
    } finally {
      open.mockRestore()
    }
  })

  it('never offers the browser row for a non-PDF hit or in the desktop shell', async () => {
    fsSearch.mockResolvedValue({ matches: ['a.ts', 'manual.pdf'], dirs: [], truncated: false })
    harness = mountPanel()
    await act(async () => {})
    await search(harness.container, 'a')

    await openMenu(rowByText(harness.container, 'a.ts'))
    expect(menuLabels()).not.toContain('Open in browser')
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })

    const doc = globalThis.document as { baseURI?: string }
    const previous = doc.baseURI
    Object.defineProperty(doc, 'baseURI', { value: 'dsh-app://app/', configurable: true, writable: true })
    try {
      await openMenu(rowByText(harness.container, 'manual.pdf'))
      expect(menuLabels()).toContain('Download')
      expect(menuLabels()).not.toContain('Open in browser')
    } finally {
      Object.defineProperty(doc, 'baseURI', { value: previous, configurable: true, writable: true })
    }
  })

  it('hides reveal-in-tree and copy-relative for a hit outside the cwd', async () => {
    fsSearch.mockResolvedValue({ matches: ['/elsewhere/notes.md'], dirs: [], truncated: false })
    harness = mountPanel({ openInApp: fakeOpenInApp(), onOpenFileNewTab: vi.fn(), onOpenFileSide: vi.fn() })
    await act(async () => {})
    await search(harness.container, 'notes')

    await openMenu(rowByText(harness.container, '/elsewhere/notes.md'))
    expect(menuLabels()).toEqual([
      'Open',
      'Open in New Tab',
      'Open to the Side',
      'Download',
      'Reveal in File Manager',
      'Copy absolute path',
    ])
  })

  it('offers a cwd-external directory only file manager + absolute copy', async () => {
    fsSearch.mockResolvedValue({ matches: ['/elsewhere/records'], dirs: ['/elsewhere/records'], truncated: false })
    harness = mountPanel({ openInApp: fakeOpenInApp() })
    await act(async () => {})
    await search(harness.container, '/elsewhere/records')

    await openMenu(rowByText(harness.container, '/elsewhere/records'))
    expect(menuLabels()).toEqual(['Reveal in File Manager', 'Copy absolute path'])
  })

  it('closes the menu when the query changes', async () => {
    fsSearch.mockResolvedValue({ matches: ['a.ts'], dirs: [], truncated: false })
    harness = mountPanel()
    await act(async () => {})
    await search(harness.container, 'a')
    await openMenu(rowByText(harness.container, 'a.ts'))
    expect(menuLabels()).toContain('Open')

    await search(harness.container, 'b')
    expect(menuLabels()).toEqual([])
  })

  it('closes the menu when the tab is parked', async () => {
    fsSearch.mockResolvedValue({ matches: ['a.ts'], dirs: [], truncated: false })
    harness = mountPanel({ visible: true })
    await act(async () => {})
    await search(harness.container, 'a')
    await openMenu(rowByText(harness.container, 'a.ts'))
    expect(menuLabels()).toContain('Open')

    // Native tab bodies keep their DOM while parked: the menu must not linger.
    await act(async () => { harness.rerender({ visible: false }) })
    expect(menuLabels()).toEqual([])
  })

  it('opens from the keyboard (ContextMenu key) as well as right-click', async () => {
    fsSearch.mockResolvedValue({ matches: ['a.ts'], dirs: [], truncated: false })
    harness = mountPanel()
    await act(async () => {})
    await search(harness.container, 'a')

    await act(async () => {
      rowByText(harness.container, 'a.ts').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(menuLabels()).toContain('Open')
  })

  it('does not touch the file tree’s selection', async () => {
    fsSearch.mockResolvedValue({ matches: ['a.ts'], dirs: [], truncated: false })
    harness = mountPanel()
    await act(async () => {})
    await search(harness.container, 'a')
    expect(treeBody(harness.container).querySelector('[class*="explorerRowSelected"]')).toBeNull()

    await openMenu(rowByText(harness.container, 'a.ts'))
    expect(menuLabels().length).toBeGreaterThan(0)
    expect(treeBody(harness.container).querySelector('[class*="explorerRowSelected"]')).toBeNull()
  })

  it('reports a failed reveal in the search panel, not in the hidden tree', async () => {
    fsSearch.mockResolvedValue({ matches: ['a.ts'], dirs: [], truncated: false })
    const reveal = vi.fn(async () => false)
    harness = mountPanel({ openInApp: fakeOpenInApp({ reveal }) })
    await act(async () => {})
    await search(harness.container, 'a')

    await openMenu(rowByText(harness.container, 'a.ts'))
    await clickMenuitem('Reveal in File Manager')
    expect(reveal).toHaveBeenCalledWith('/tmp/a.ts')
    expect(harness.container.textContent).toContain('Could not open: /tmp/a.ts')
  })

  it('copies the relative path and shows the transient hint', async () => {
    fsSearch.mockResolvedValue({ matches: ['a.ts'], dirs: [], truncated: false })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      harness = mountPanel()
      await act(async () => {})
      await search(harness.container, 'a')

      await openMenu(rowByText(harness.container, 'a.ts'))
      await clickMenuitem('Copy relative path')
      expect(writeText).toHaveBeenCalledWith('a.ts')
      expect(harness.container.textContent).toContain('Copied')
    } finally {
      Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true })
    }
  })
})
