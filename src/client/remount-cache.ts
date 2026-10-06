/**
 * Visibility-remount memory for the native right Sidebar.
 *
 * DSH's dock layout unmounts a hidden tab's body unless the tab type declares
 * `keepMounted` (the editor kind deliberately does NOT — every open file is a
 * CodeMirror instance and retaining them all does not scale). A body that
 * remounts when its tab is re-selected used to start from scratch: the editor
 * host re-fetched the file (a visible "auto refresh" on every tab switch) and
 * an unsaved draft living in the destroyed CodeMirror view was silently
 * dropped — the manual refresh button confirms before discarding a dirty
 * draft, but the tab switch had no such guard.
 *
 * What must survive a tab switch lives here instead, keyed by TAB INSTANCE
 * (never by path — two tabs can show one file, and one tab can switch files
 * in place). Two stores:
 *
 * - the LOAD cache: one tab's last ready load (the viewer match plus its
 *   fetched payload). A remount with `reloadSeq === 0` restores it instead of
 *   re-fetching; the manual refresh button bumps `reloadSeq` and always goes
 *   to the filesystem. Entries for closed tabs simply age out.
 * - the DRAFT memory: one tab's unsaved text-editor draft, captured when the
 *   CodeMirror view is destroyed while dirty. A draft restores ONLY while its
 *   base (the content the view was created from) still matches the freshly
 *   loaded content — a manual refresh discards it through
 *   {@link dropRemountDraft}, exactly the confirm's promise.
 *
 * Both are bounded LRU maps: the host gives no "tab hidden" hook (only the
 * occurrence signal on CLOSE, which the records registry already consumes),
 * so eviction — not an exact lifecycle — bounds the memory.
 */
import type { FileViewerDescriptor } from './service.ts'

/** The per-store entry cap (oldest evicted first). */
const REMOUNT_CACHE_CAP = 16

/** Read an entry and mark it most-recently-used. */
function touchGet<V>(map: Map<string, V>, key: string): V | undefined {
  const value = map.get(key)
  if (value !== undefined) {
    map.delete(key)
    map.set(key, value)
  }
  return value
}

/** Write an entry (most-recently-used), evicting the oldest beyond the cap. */
function put<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > REMOUNT_CACHE_CAP) {
    map.delete(map.keys().next().value!)
  }
}

/** One tab instance's ready load: the matched viewer plus its payload. */
export interface RemountLoad {
  /** The path the load belongs to (a remount restores only on a match). */
  readonly path: string
  readonly viewer: FileViewerDescriptor
  readonly content?: string
  readonly truncated?: boolean
  readonly mediaUrl?: string
  readonly customData?: unknown
}

const remountLoads = new Map<string, RemountLoad>()

/** The cached ready load of one tab instance (undefined when never loaded). */
export function readRemountLoad(key: string): RemountLoad | undefined {
  return touchGet(remountLoads, key)
}

/** Cache one tab instance's ready load. */
export function writeRemountLoad(key: string, load: RemountLoad): void {
  put(remountLoads, key, load)
}

/** One tab instance's unsaved draft. */
export interface RemountDraft {
  /** The content the CodeMirror view was created from (the restore guard). */
  readonly base: string
  /** The live document text at capture time. */
  readonly text: string
  /** The view mode at capture time (restored with the draft). */
  readonly mode: 'preview' | 'edit'
}

const remountDrafts = new Map<string, RemountDraft>()

/**
 * One tab instance's remembered draft, but ONLY while its base still matches
 * the content at hand — a draft captured before a manual refresh (new base)
 * or belonging to a different file (an in-place switch) never restores.
 * @param key - the tab-instance key.
 * @param base - the content the restore would sit on top of.
 * @returns the draft, or undefined when absent or stale.
 */
export function readRemountDraft(key: string, base: string): RemountDraft | undefined {
  const draft = touchGet(remountDrafts, key)
  return draft !== undefined && draft.base === base ? draft : undefined
}

/** Capture one tab instance's unsaved draft. */
export function writeRemountDraft(key: string, draft: RemountDraft): void {
  put(remountDrafts, key, draft)
}

/**
 * Forget one tab instance's draft (unconditional — the manual refresh's
 * confirmed discard, where the current base is irrelevant).
 */
export function dropRemountDraft(key: string): void {
  remountDrafts.delete(key)
}

/**
 * Forget a draft only when it still sits on the given base. The CodeMirror
 * cleanup of a CLEAN view runs this so an older dirty draft of the same tab
 * (captured before an in-place file switch) survives a later clean teardown.
 */
export function dropRemountDraftIfBase(key: string, base: string): void {
  if (remountDrafts.get(key)?.base === base) remountDrafts.delete(key)
}

/** Test hook: both stores are module-level, so specs must reset them. */
export function clearRemountCachesForTests(): void {
  remountLoads.clear()
  remountDrafts.clear()
}
