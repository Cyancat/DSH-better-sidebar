/**
 * Deployment-level proof for the editor header's "Open in browser" button.
 *
 * Unit/component specs pin the button's presence, its `window.open` arguments
 * and the tab close, but only a REAL browser can prove the hand-off the user
 * actually gets:
 *
 *  - the button exists in a deployed Web window (not hidden by the
 *    `canOpenInBrowser()` gate);
 *  - the new tab is allowed to navigate (the host's auth cookie is shared —
 *    a deployment without it would 401, the known failure mode of a hand-built
 *    host URL);
 *  - the loaded document is the sandboxed `/sidebar/html` route and stays in
 *    an opaque origin (`self.origin === 'null'`, storage access throws — so it
 *    cannot read the GUI's localStorage / same-origin `/sidebar/api/*`), has
 *    `window.opener === null` (`_blank` + `noopener`), and its own scripts
 *    still run;
 *  - the sidebar tab closes after the hand-off.
 *
 * PDF's "open in browser" row is intentionally not covered here: headless
 * Chromium has no PDF viewer UI, so it could only assert the response, not the
 * render — that gate stays manual (see docs/cyan/2026-10-21-open-in-browser-port-record.md).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc, sendFirstMessage } from './host'

const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE_OPEN_IN_BROWSER
  ?? join(tmpdir(), `dsh-e2e-open-in-browser-${process.pid}`)

const HTML_FILE = 'open-in-browser.html'
const HTML_MARKER = 'open in browser works'

/** A page whose own script paints the title and rewrites the body marker. */
const HTML = `<!doctype html>
<html>
  <head><title>before-script</title></head>
  <body>
    <h1 id="title">${HTML_MARKER}</h1>
    <p id="script-state">script did not run</p>
    <script>
      document.getElementById('script-state').textContent = 'script ran'
      document.title = 'sandbox-script-ran'
    </script>
  </body>
</html>
`

let api: APIRequestContext

test.beforeAll(async () => {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, HTML_FILE), HTML)
  api = await createHostApi()
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
  await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
})

test.afterAll(async () => {
  await api?.dispose()
})

test('the html editor hands the file to a sandboxed real browser tab and closes itself', async ({ page }) => {
  await gotoPage(page)
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  // The native right Sidebar's corner control renders only for a session with
  // content; the seeded session starts blank.
  await sendFirstMessage(page)

  // Open the plugin's files window through the host's own guide.
  await page.locator('[data-sidebar-right-expand]').first().click()
  const pane = page.locator('[data-sidebar-right-panel]')
  await expect(pane).toBeVisible({ timeout: 30_000 })
  if (await page.locator('[data-sidebar-right-guide]').count() === 0) {
    await page.locator('[data-dockkit-add-tab]').first().click()
  }
  await page.locator('[data-sidebar-right-guide-entry="files"]').click()

  const row = pane.locator(`[role="button"][title$="${HTML_FILE}"]:visible`)
  await expect(row, `the seeded "${HTML_FILE}" must appear in the explorer`).toHaveCount(1, { timeout: 30_000 })
  // Click near the LEFT edge: hovering reveals the @-reference button at the
  // row's right end.
  await row.click({ position: { x: 8, y: 8 } })

  const button = pane.locator('button[aria-label="Open in browser"]')
  await expect(
    button,
    'the deployed Web window must show the open-in-browser button for an html file',
  ).toHaveCount(1, { timeout: 30_000 })

  const popupPromise = page.context().waitForEvent('page')
  await button.click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')

  const url = new URL(popup.url())
  // The tab really navigated to the html route (and did not 401 / 404).
  expect(url.pathname).toContain('/sidebar/html/')
  await expect(popup.locator('#title')).toHaveText(HTML_MARKER, { timeout: 30_000 })
  // Its own script ran…
  await expect(popup.locator('#script-state')).toHaveText('script ran')
  await expect.poll(() => popup.title(), { timeout: 10_000 }).toBe('sandbox-script-ran')
  // …but its document is sandboxed into an opaque origin: `self.origin` is
  // "null" and storage access throws. NOTE: Chromium keeps `location.origin`
  // at the URL's http(s) origin even under CSP `sandbox` (unlike `self.origin`),
  // so the URL field alone is NOT evidence of the boundary — probe the
  // security-relevant surfaces instead.
  expect(await popup.evaluate(() => self.origin)).toBe('null')
  expect(await popup.evaluate(() => {
    try {
      localStorage.getItem('dsh-better-sidebar')
      return 'allowed'
    } catch {
      return 'blocked'
    }
  })).toBe('blocked')
  expect(await popup.evaluate(() => window.opener)).toBeNull()

  // The hand-off closes the sidebar tab: its editor (and the header button)
  // is gone from the pane.
  await expect(button).toHaveCount(0, { timeout: 30_000 })
  await popup.close()
})
