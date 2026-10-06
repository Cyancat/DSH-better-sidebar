/**
 * TextEditor draft memory across a visibility remount (the native right
 * Sidebar unmounts a hidden tab's body): an unsaved draft is captured when
 * the CodeMirror view is destroyed and restores onto the SAME base content —
 * with the dirty flag and the edit mode — while a base change (a refreshed
 * or switched file) and the host's confirmed discard both start clean.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { EditorView } from '@codemirror/view'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { clearRemountCachesForTests } from '../src/client/remount-cache.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { EditorToolbarControls, EditorToolbarState, FileViewerProps } from '../src/client/service.ts'

setupReactAct()

interface Harness {
  props: FileViewerProps
  toolbarStates: EditorToolbarState[]
  controls: () => EditorToolbarControls | null
}

function harness(content: string, remountKey = 'tab-1'): Harness {
  const toolbarStates: EditorToolbarState[] = []
  let controls: EditorToolbarControls | null = null
  const props: FileViewerProps = {
    ctx: {} as FileViewerProps['ctx'],
    store: createSidebarStore(),
    scope: { sessionId: 'draft-remount-session', cwd: '/tmp' },
    path: '/tmp/notes.md',
    title: 'notes.md',
    viewerId: 'markdown',
    content,
    remountKey,
    toolbar: 'host',
    onToolbarState: (state) => { toolbarStates.push(state) },
    onToolbarControls: (next) => { controls = next },
  }
  return { props, toolbarStates, controls: () => controls }
}

/** Type text at the end of the live CodeMirror document. */
function typeIntoEditor(container: HTMLDivElement, text: string): void {
  const dom = container.querySelector('.cm-editor')
  expect(dom).not.toBeNull()
  const view = EditorView.findFromDOM(dom as HTMLElement)
  expect(view).not.toBeNull()
  act(() => {
    view!.dispatch({ changes: { from: view!.state.doc.length, insert: text } })
  })
}

/** The CodeMirror document text currently rendered. */
function editorText(container: HTMLDivElement): string {
  const dom = container.querySelector('.cm-editor')
  const view = dom === null ? null : EditorView.findFromDOM(dom as HTMLElement)
  return view?.state.doc.toString() ?? ''
}

function lastToolbar(states: EditorToolbarState[]): EditorToolbarState {
  return states[states.length - 1]!
}

beforeEach(() => {
  clearRemountCachesForTests()
})

describe('TextEditor draft across a visibility remount', () => {
  it('restores an unsaved draft with the dirty flag and the edit mode', async () => {
    const first = harness('hello')
    const mount1 = renderRoot(createElement(TextEditor, first.props))
    await act(async () => { await Promise.resolve() })
    typeIntoEditor(mount1.container, ' world')
    expect(lastToolbar(first.toolbarStates).dirty).toBe(true)
    act(() => { first.controls()?.setMode('edit') })
    // The hide: the body unmounts, capturing the dirty draft.
    mount1.unmount()

    const second = harness('hello')
    const mount2 = renderRoot(createElement(TextEditor, second.props))
    await act(async () => { await Promise.resolve() })
    try {
      expect(editorText(mount2.container)).toBe('hello world')
      expect(lastToolbar(second.toolbarStates).dirty).toBe(true)
      expect(lastToolbar(second.toolbarStates).mode).toBe('edit')
    } finally {
      mount2.unmount()
    }
  })

  it('does not restore onto a different base (the file changed)', async () => {
    const first = harness('hello')
    const mount1 = renderRoot(createElement(TextEditor, first.props))
    await act(async () => { await Promise.resolve() })
    typeIntoEditor(mount1.container, ' world')
    mount1.unmount()

    const second = harness('hello v2')
    const mount2 = renderRoot(createElement(TextEditor, second.props))
    await act(async () => { await Promise.resolve() })
    try {
      expect(editorText(mount2.container)).toBe('hello v2')
      expect(lastToolbar(second.toolbarStates).dirty).toBe(false)
    } finally {
      mount2.unmount()
    }
  })

  it('a clean teardown captures nothing', async () => {
    const first = harness('hello')
    const mount1 = renderRoot(createElement(TextEditor, first.props))
    await act(async () => { await Promise.resolve() })
    mount1.unmount()

    const second = harness('hello')
    const mount2 = renderRoot(createElement(TextEditor, second.props))
    await act(async () => { await Promise.resolve() })
    try {
      expect(editorText(mount2.container)).toBe('hello')
      expect(lastToolbar(second.toolbarStates).dirty).toBe(false)
    } finally {
      mount2.unmount()
    }
  })

  it('the host\'s discardDraft (a confirmed refresh) keeps the draft gone', async () => {
    const first = harness('hello')
    const mount1 = renderRoot(createElement(TextEditor, first.props))
    await act(async () => { await Promise.resolve() })
    typeIntoEditor(mount1.container, ' world')
    act(() => { first.controls()?.discardDraft?.() })
    expect(lastToolbar(first.toolbarStates).dirty).toBe(false)
    mount1.unmount()

    const second = harness('hello')
    const mount2 = renderRoot(createElement(TextEditor, second.props))
    await act(async () => { await Promise.resolve() })
    try {
      expect(editorText(mount2.container)).toBe('hello')
      expect(lastToolbar(second.toolbarStates).dirty).toBe(false)
    } finally {
      mount2.unmount()
    }
  })

  it('keeps one tab\'s draft out of another tab showing the same file', async () => {
    const first = harness('hello', 'tab-1')
    const mount1 = renderRoot(createElement(TextEditor, first.props))
    await act(async () => { await Promise.resolve() })
    typeIntoEditor(mount1.container, ' world')
    mount1.unmount()

    // A second tab (a side-open of the same path) remounts: no draft leaks.
    const second = harness('hello', 'tab-2')
    const mount2 = renderRoot(createElement(TextEditor, second.props))
    await act(async () => { await Promise.resolve() })
    try {
      expect(editorText(mount2.container)).toBe('hello')
      expect(lastToolbar(second.toolbarStates).dirty).toBe(false)
    } finally {
      mount2.unmount()
    }
  })
})
