/**
 * The remount cache stores (remount-cache.ts): LRU bounds, the draft's
 * base-match restore guard, and the two drop semantics (unconditional for
 * the confirmed manual refresh, base-checked for a clean view teardown).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearRemountCachesForTests,
  dropRemountDraft,
  dropRemountDraftIfBase,
  readRemountDraft,
  readRemountLoad,
  writeRemountDraft,
  writeRemountLoad,
} from '../src/client/remount-cache.ts'
import type { FileViewerDescriptor } from '../src/client/service.ts'

const VIEWER = { id: 'code', exts: [], fetchStrategy: 'fsRead', component: () => null } as FileViewerDescriptor

beforeEach(() => {
  clearRemountCachesForTests()
})

describe('remount load cache', () => {
  it('round-trips one tab instance\'s ready load', () => {
    expect(readRemountLoad('s::tab-1')).toBeUndefined()
    writeRemountLoad('s::tab-1', { path: '/tmp/a.ts', viewer: VIEWER, content: 'hello' })
    expect(readRemountLoad('s::tab-1')).toMatchObject({ path: '/tmp/a.ts', content: 'hello' })
  })

  it('evicts the oldest entry beyond the cap', () => {
    for (let index = 0; index < 20; index += 1) {
      writeRemountLoad(`s::tab-${index}`, { path: `/tmp/${index}.ts`, viewer: VIEWER })
    }
    // Cap is 16: the four oldest are gone, the newest survive.
    for (let index = 0; index < 4; index += 1) {
      expect(readRemountLoad(`s::tab-${index}`)).toBeUndefined()
    }
    for (let index = 4; index < 20; index += 1) {
      expect(readRemountLoad(`s::tab-${index}`)).toBeDefined()
    }
  })
})

describe('remount draft memory', () => {
  it('restores only while the base matches', () => {
    writeRemountDraft('s::tab-1', { base: 'one', text: 'one edited', mode: 'edit' })
    expect(readRemountDraft('s::tab-1', 'one')).toMatchObject({ text: 'one edited', mode: 'edit' })
    // A refreshed file (new base) never sees the stale draft.
    expect(readRemountDraft('s::tab-1', 'two')).toBeUndefined()
  })

  it('dropRemountDraft forgets unconditionally (the confirmed refresh discard)', () => {
    writeRemountDraft('s::tab-1', { base: 'one', text: 'one edited', mode: 'edit' })
    dropRemountDraft('s::tab-1')
    expect(readRemountDraft('s::tab-1', 'one')).toBeUndefined()
  })

  it('dropRemountDraftIfBase spares a draft sitting on another base', () => {
    // An in-place switch captured file A's dirty draft; tearing down file
    // B's clean view (base B) must not take A's draft with it.
    writeRemountDraft('s::tab-1', { base: 'content-a', text: 'a edited', mode: 'edit' })
    dropRemountDraftIfBase('s::tab-1', 'content-b')
    expect(readRemountDraft('s::tab-1', 'content-a')).toBeDefined()
    dropRemountDraftIfBase('s::tab-1', 'content-a')
    expect(readRemountDraft('s::tab-1', 'content-a')).toBeUndefined()
  })
})
