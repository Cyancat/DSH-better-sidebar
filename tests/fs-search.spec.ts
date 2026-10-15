/**
 * fs-search: the host's recursive file-name search behind the editor side
 * panel's search box. Matches are case-insensitive name substrings, reported
 * RELATIVE to the root ('/'-separated) and flagged with their directory-ness
 * (the client reveals directory hits in the tree instead of opening them as
 * files); noise directories (`.git`, `node_modules`, build caches) are
 * skipped, symlinked directories are never descended (cycle safety), and
 * the maxMatches/maxVisited budgets stop a runaway walk with
 * `truncated: true`.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchFiles } from '../src/fs-search.ts'

/**
 * Symlink creation needs extra privileges on Windows; the symlink case skips
 * there rather than fails (mirror of the fs-tree symlink spec).
 */
const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-probe-'))
  try {
    symlinkSync('target', join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

/** A scratch tree: nested matches, a .git dir, and unrelated noise. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'docs'))
  mkdirSync(join(dir, '.git'))
  mkdirSync(join(dir, '.git', 'objects'))
  writeFileSync(join(dir, 'README.md'), 'readme')
  writeFileSync(join(dir, 'src', 'Index.TS'), 'code')
  writeFileSync(join(dir, 'src', 'util.ts'), 'code')
  writeFileSync(join(dir, 'docs', 'guide.md'), 'doc')
  writeFileSync(join(dir, '.git', 'config'), 'git-internal')
  writeFileSync(join(dir, '.git', 'objects', 'readme-pack'), 'git-internal')
  return dir
}

describe('fs-search', () => {
  it('matches name substrings and reports root-relative /-separated paths', async () => {
    const dir = makeFixture()
    try {
      const result = await searchFiles(dir, 'util')
      expect(result).toEqual({ matches: [{ path: 'src/util.ts', isDir: false }], truncated: false })
      // A multi-level match list is sorted and relative (never absolute).
      const md = await searchFiles(dir, '.md')
      expect(md.truncated).toBe(false)
      expect(md.matches).toEqual([
        { path: 'README.md', isDir: false },
        { path: 'docs/guide.md', isDir: false },
      ])
      for (const match of md.matches) {
        expect(match.path.startsWith(dir)).toBe(false)
        expect(match.path).not.toContain('\\')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matches case-insensitively on the entry name', async () => {
    const dir = makeFixture()
    try {
      expect((await searchFiles(dir, 'index.ts')).matches).toEqual([{ path: 'src/Index.TS', isDir: false }])
      expect((await searchFiles(dir, 'INDEX.TS')).matches).toEqual([{ path: 'src/Index.TS', isDir: false }])
      // Directory names match too — flagged so the client reveals them in
      // the tree instead of opening them as files.
      expect((await searchFiles(dir, 'SRC')).matches).toEqual([{ path: 'src', isDir: true }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags files and directories in a mixed hit set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-mixed-'))
    try {
      mkdirSync(join(dir, 'app', 'app-data'), { recursive: true })
      writeFileSync(join(dir, 'app', 'app.ts'), 'code')
      writeFileSync(join(dir, 'app', 'app-data', 'app.json'), 'data')
      const result = await searchFiles(dir, 'app')
      expect(result.truncated).toBe(false)
      expect(result.matches).toEqual([
        { path: 'app', isDir: true },
        { path: 'app/app-data', isDir: true },
        { path: 'app/app-data/app.json', isDir: false },
        { path: 'app/app.ts', isDir: false },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never descends into .git directories', async () => {
    const dir = makeFixture()
    try {
      // 'readme' would hit .git/objects/readme-pack if the walk entered .git.
      expect((await searchFiles(dir, 'readme')).matches).toEqual([{ path: 'README.md', isDir: false }])
      expect((await searchFiles(dir, 'config')).matches).toEqual([])
      expect((await searchFiles(dir, '.git')).matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never descends into node_modules or other noise directories', async () => {
    const dir = makeFixture()
    try {
      mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
      mkdirSync(join(dir, 'web', 'dist'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'left-pad', 'guide.md'), 'dep')
      writeFileSync(join(dir, 'web', 'dist', 'bundle.js'), 'build')
      writeFileSync(join(dir, 'web', 'app.ts'), 'src')
      // A match hidden behind node_modules / dist must not appear; project
      // files after those forests must still be reachable within budget.
      expect((await searchFiles(dir, 'guide')).matches).toEqual([{ path: 'docs/guide.md', isDir: false }])
      expect((await searchFiles(dir, 'left-pad')).matches).toEqual([])
      expect((await searchFiles(dir, 'bundle')).matches).toEqual([])
      expect((await searchFiles(dir, 'app.ts')).matches).toEqual([{ path: 'web/app.ts', isDir: false }])
      expect((await searchFiles(dir, 'node_modules')).matches).toEqual([])
      expect((await searchFiles(dir, 'dist')).matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an empty (or whitespace) query matches nothing without walking', async () => {
    const dir = makeFixture()
    try {
      expect(await searchFiles(dir, '')).toEqual({ matches: [], truncated: false })
      expect(await searchFiles(dir, '   ')).toEqual({ matches: [], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('does not descend into symlinked directories (cycle safety)', async () => {
    const dir = makeFixture()
    try {
      // A link back to the root would loop forever if descended; a link to
      // src would duplicate its matches. Neither must be entered.
      symlinkSync(dir, join(dir, 'loop'))
      symlinkSync(join(dir, 'src'), join(dir, 'src-link'))
      const result = await searchFiles(dir, 'util')
      expect(result).toEqual({ matches: [{ path: 'src/util.ts', isDir: false }], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops with truncated: true when the match budget is exceeded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-cap-'))
    try {
      for (let index = 0; index < 5; index += 1) {
        writeFileSync(join(dir, `match-${index}.txt`), 'x')
      }
      const result = await searchFiles(dir, 'match', { maxMatches: 2 })
      expect(result.truncated).toBe(true)
      expect(result.matches.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops with truncated: true when the visited budget is exceeded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-visited-'))
    try {
      for (let index = 0; index < 5; index += 1) {
        writeFileSync(join(dir, `file-${index}.txt`), 'x')
      }
      // The walk visits more entries than the budget allows and gives up.
      const result = await searchFiles(dir, 'nomatch', { maxVisited: 3 })
      expect(result.truncated).toBe(true)
      expect(result.matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unreadable root yields no matches instead of throwing', async () => {
    const dir = makeFixture()
    try {
      const missing = join(dir, 'does-not-exist')
      expect(await searchFiles(missing, 'x')).toEqual({ matches: [], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
