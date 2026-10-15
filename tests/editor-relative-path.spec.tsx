/**
 * Regression: a RELATIVE path landing in an editor tab (a deliverables card
 * opens the path exactly as the `present` tool stored it) must be resolved
 * against the session cwd before any consumer sees it. `fs.read` resolves a
 * relative path server-side, but the URL-routed previews (`/sidebar/html`,
 * the media route) decode it back with an unconditional leading '/', so
 * 'workspace/contract/a.html' became the ENOENT '/workspace/contract/a.html'.
 * EditorHost now resolves `tab.path` against the live scope cwd, so fsRead,
 * the viewer props and `browserUrl` all see the absolute form.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { clearRemountCachesForTests } from '../src/client/remount-cache.ts'
import { createBetterSidebarService, type FileViewerProps } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
setupReactAct()

const fsRead = vi.fn()
vi.mock('../src/client/api.ts', () => ({
  api: { fsRead: (...args: unknown[]) => fsRead(...args) },
  mediaUrl: () => '',
  isOutsideWorkspaceMessage: () => false,
}))

/** The paths the viewer component was rendered with (FileViewerProps.path). */
const viewerPaths: string[] = []

function setup(tabPath: string): {
  ctx: Context
  fileTab: () => SidebarTab
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  service.registerFileViewer({
    id: 'mock-html',
    exts: ['html'],
    priority: 0,
    fetchStrategy: 'fsRead',
    browserUrl: (scope, path) => `/sidebar/html/${scope.sessionId}${path}`,
    component: (props: FileViewerProps) => {
      viewerPaths.push(props.path)
      return createElement('div', null, 'mock-html')
    },
  })
  store.setSession('s1')
  const sessionsSnapshot = { byId: { s1: { cwd: '/home/me/proj' } }, current: 's1' }
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  } as unknown as Context
  ctx.betterSidebar.openTab({ type: 'editor', title: 'a.html', path: tabPath, id: `editor:${tabPath}` })
  const fileTab = (): SidebarTab =>
    allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
      .find(tab => tab.path === tabPath)!
  return { ctx, fileTab }
}

function mount(ctx: Context, tab: () => SidebarTab, cwd: string | undefined) {
  return renderRoot(createElement(EditorHost, {
    ctx, store: ctx.betterSidebar as never, scope: { sessionId: 's1', cwd },
    tab: tab(), expanded: [], revealed: [], onToggleDir: () => {}, onRevealDir: () => {}, onReferenceFile: () => {},
  }))
}

beforeEach(() => {
  fsRead.mockReset()
  fsRead.mockResolvedValue({ kind: 'text', content: '<p>hi</p>', truncated: false })
  viewerPaths.length = 0
  // The remount load cache is module-level: no carry-over between tests.
  clearRemountCachesForTests()
})

describe('EditorHost relative-path resolution (deliverables card regression)', () => {
  it('resolves a relative tab path against the scope cwd before fsRead and the viewer see it', async () => {
    const { ctx, fileTab } = setup('workspace/contract/a.html')
    const { container, unmount } = mount(ctx, fileTab, '/home/me/proj')
    try {
      // Settle the async fsRead → viewer render.
      await act(async () => { await Promise.resolve() })
      expect(fsRead).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1', cwd: '/home/me/proj' }),
        '/home/me/proj/workspace/contract/a.html',
      )
      expect(viewerPaths).toContain('/home/me/proj/workspace/contract/a.html')
      // The header input still DISPLAYS the cwd-relative spelling.
      const input = container.querySelector('input') as HTMLInputElement | null
      expect(input?.value).toBe('workspace/contract/a.html')
    } finally {
      unmount()
    }
  })

  it('leaves an absolute tab path untouched (no regression for absolute cards)', async () => {
    const { ctx, fileTab } = setup('/home/me/proj/a.html')
    const { unmount } = mount(ctx, fileTab, '/home/me/proj')
    try {
      await act(async () => { await Promise.resolve() })
      expect(fsRead).toHaveBeenCalledWith(expect.anything(), '/home/me/proj/a.html')
      expect(viewerPaths).toContain('/home/me/proj/a.html')
    } finally {
      unmount()
    }
  })

  it('cannot resolve without a cwd: the path stays relative and fsRead keeps its server-side resolution', async () => {
    const { ctx, fileTab } = setup('workspace/contract/a.html')
    const { unmount } = mount(ctx, fileTab, undefined)
    try {
      await act(async () => { await Promise.resolve() })
      expect(fsRead).toHaveBeenCalledWith(expect.anything(), 'workspace/contract/a.html')
    } finally {
      unmount()
    }
  })
})
