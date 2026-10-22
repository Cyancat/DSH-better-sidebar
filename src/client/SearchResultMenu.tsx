/**
 * The file-name search results' row menu: a READ-ONLY action set for one flat
 * result. The file tree's row menu cannot be reused here — right-clicking a
 * result would rewrite the tree's selection, expose rename / delete / upload /
 * new-file rows that a cwd-external hit must not offer, and report failures in
 * a strip the hidden tree still owns. This menu keeps that state untouched and
 * reports its own failures in the search panel's hint line.
 *
 * Entries, by target (see docs/cyan/2026-10-22-search-results-context-menu-plan.md
 * §2.2; the plan file itself is committed with this feature):
 * - file in the cwd: open / new tab / side / browser (PDF, Web only) /
 *   download / reveal in file manager / reveal in tree / copy relative /
 *   copy absolute;
 * - file outside the cwd: the same minus reveal-in-tree and copy-relative
 *   (the tree is cwd-rooted and the host's workspace fence owns the rest);
 * - directory in the cwd: reveal in tree / file manager / copy relative /
 *   copy absolute;
 * - directory outside the cwd: file manager / copy absolute.
 * No mutation rows, no multi-selection, no drag: flat search results are not
 * the tree's selection.
 *
 * The PDF action shares `open-in-browser.ts` with the file tree's row menu, so
 * both entries open the same inline `mediaUrl()` URL with `_blank` +
 * `noopener` and both hide in the desktop shell (`canOpenInBrowser`).
 */
import {
  IconCodeOutlineRegular, IconCopyOutlineRegular, IconDownloadOutlineRegular,
  IconFlatListOutlineRegular, IconFolderOpenRegular,
  Menu, type MenuEntry, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { VscLinkExternal } from 'react-icons/vsc'
import { downloadUrl, type SessionScope } from './api.ts'
import { canOpenInBrowser } from './desktop-env.ts'
import { t } from './locales.ts'
import { browserOpenUrl, isBrowserOpenablePath, openBrowserTab } from './open-in-browser.ts'
import { isWithinWorkspace, relativeTo } from './paths.ts'

/** One right-clicked result row (state owned by TreePanel). */
export interface SearchResultMenuTarget {
  /** The result row's RELATIVE spelling (the tree reveal is keyed on it). */
  rel: string
  /** Absolute path after resolveSidebarPath (every file action uses it). */
  path: string
  /** Directory hits come from `results.dirs`, never from a suffix guess. */
  isDir: boolean
  x: number
  y: number
}

export interface SearchResultMenuProps {
  /** The row the menu points at; null closes it. */
  target: SearchResultMenuTarget | null
  scope: SessionScope
  cwd: string | undefined
  onClose: () => void
  /** Left-click semantics: file → onOpenFile; directory → tree reveal. */
  onActivate: (target: SearchResultMenuTarget) => void
  /** Expand ancestors and clear the query; cwd-internal targets only. */
  onRevealInTree: (target: SearchResultMenuTarget) => void
  onOpenNewTab?: (path: string) => void
  onOpenSide?: (path: string) => void
  /** The host's reveal handle; absent → the row is hidden. */
  onRevealInFileManager?: (path: string) => Promise<boolean> | boolean
  /** Transient hint (copy success) or sticky error (open failure). */
  onNotify: (message: string, failed?: boolean) => void
}

/** Download one file through the host route (raw bytes, binary-safe). */
function downloadFile(scope: SessionScope, path: string): void {
  const anchor = document.createElement('a')
  anchor.href = downloadUrl(scope, path)
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/** Copy text; a failed clipboard write stays silent (the tree's behavior). */
function copyText(text: string, onDone: () => void): void {
  void writeClipboard(text).then((ok) => { if (ok) onDone() })
}

/** Build the menu rows for one target, grouped by a separator between groups. */
function menuEntries(props: SearchResultMenuProps, target: SearchResultMenuTarget): MenuEntry[] {
  const { cwd, onOpenNewTab, onOpenSide, onRevealInFileManager } = props
  const inWorkspace = cwd !== undefined && isWithinWorkspace(cwd, target.path)
  const isPdf = !target.isDir && isBrowserOpenablePath(target.path)
  const groups: MenuEntry[][] = []

  if (target.isDir) {
    if (inWorkspace) {
      groups.push([
        { id: 'search-reveal-tree', label: t('searchRevealInTree'), icon: <IconFlatListOutlineRegular size={14} /> },
      ])
    }
  } else {
    groups.push([
      { id: 'search-open', label: t('searchOpen'), icon: <IconCodeOutlineRegular size={14} /> },
    ])
    const openEscapes: MenuEntry[] = []
    if (onOpenNewTab !== undefined) {
      openEscapes.push({ id: 'search-new-tab', label: t('openFileNewTab'), icon: <IconCodeOutlineRegular size={14} /> })
    }
    if (onOpenSide !== undefined) {
      openEscapes.push({ id: 'search-side', label: t('openFileSide'), icon: <IconFolderOpenRegular size={14} /> })
    }
    // A real browser tab for types the browser renders natively (PDF);
    // zero rows for every other file and in the desktop shell.
    if (isPdf && canOpenInBrowser()) {
      openEscapes.push({ id: 'search-pdf-browser', label: t('browserOpenExternal'), icon: <VscLinkExternal size={14} /> })
    }
    if (openEscapes.length > 0) groups.push(openEscapes)
    groups.push([
      { id: 'search-download', label: t('download'), icon: <IconDownloadOutlineRegular size={14} /> },
    ])
  }

  const utilities: MenuEntry[] = []
  if (onRevealInFileManager !== undefined) {
    utilities.push({
      id: 'search-reveal-file-manager',
      label: t('revealInFileManager'),
      icon: <IconFolderOpenRegular size={14} />,
    })
  }
  if (!target.isDir && inWorkspace) {
    utilities.push({
      id: 'search-reveal-tree',
      label: t('searchRevealInTree'),
      icon: <IconFlatListOutlineRegular size={14} />,
    })
  }
  if (utilities.length > 0) groups.push(utilities)

  // The relative spelling exists only inside the tree's root; the absolute one
  // is always meaningful (a pasted external path is still a real path).
  const copies: MenuEntry[] = []
  if (inWorkspace) {
    copies.push({ id: 'search-copy-relative', label: t('copyRelative'), icon: <IconCopyOutlineRegular size={14} /> })
  }
  copies.push({ id: 'search-copy-absolute', label: t('copyAbsolute'), icon: <IconCopyOutlineRegular size={14} /> })
  groups.push(copies)

  return groups.flatMap((rows, index) => (index === 0
    ? rows
    : [{ type: 'separator' as const, id: `search-sep-${index}` }, ...rows]))
}

export function SearchResultMenu(props: SearchResultMenuProps) {
  const { target, scope, cwd, onClose, onActivate, onRevealInTree, onRevealInFileManager, onNotify } = props

  const fail = (path: string): void => { onNotify(t('openInAppFailed', { path }), true) }

  const revealInFileManager = (path: string): void => {
    if (onRevealInFileManager === undefined) return
    // A synchronous throw and a rejected promise are one failure path: the
    // caller must hear about it in the search hint, never in a hidden tree.
    void Promise.resolve().then(() => onRevealInFileManager(path)).then(
      (opened) => { if (!opened) fail(path) },
      () => { fail(path) },
    )
  }

  return (
    <Menu
      open={target !== null}
      onClose={onClose}
      items={target === null ? [] : menuEntries(props, target)}
      onSelect={(id) => {
        const picked = target
        if (picked === null) return
        // Close BEFORE acting, like the file tree: the row unmounts with the
        // list, and a follow-up state change must not race the menu.
        onClose()
        if (id === 'search-open') {
          onActivate(picked)
          return
        }
        if (id === 'search-reveal-tree') {
          onRevealInTree(picked)
          return
        }
        if (id === 'search-new-tab') {
          props.onOpenNewTab?.(picked.path)
          return
        }
        if (id === 'search-side') {
          props.onOpenSide?.(picked.path)
          return
        }
        if (id === 'search-pdf-browser') {
          if (!openBrowserTab(browserOpenUrl(scope, picked.path))) fail(picked.path)
          return
        }
        if (id === 'search-download') {
          downloadFile(scope, picked.path)
          return
        }
        if (id === 'search-reveal-file-manager') {
          revealInFileManager(picked.path)
          return
        }
        if (id === 'search-copy-relative') {
          copyText(cwd === undefined ? picked.path : relativeTo(cwd, picked.path), () => { onNotify(t('copied')) })
          return
        }
        if (id === 'search-copy-absolute') {
          copyText(picked.path, () => { onNotify(t('copied')) })
        }
      }}
      portal
      compact
      align="start"
      getAnchorRect={() => (target === null ? null : new DOMRect(target.x, target.y, 0, 0))}
      anchor={<span />}
    />
  )
}
