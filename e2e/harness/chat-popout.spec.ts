// Popping team chat out into a window of its own (?path=/dashboard).
//
// THE FAILURE THIS EXISTS TO CATCH. Chat now has four homes — the header
// dropdown, the dashboard rail dock, the full /chat page, and a window of its
// own — all driven by ONE `placement` value on a store that is mounted once.
// Every one of them reads that value independently, so the way this breaks is
// chat appearing in two places at once: the panel floating in the header while
// a second copy of the same conversation sits in the popped-out window, both
// live, both stamping messages read. Nothing throws when that happens, and on
// the machine of whoever built it — where the window opens instantly — it can
// look fine. So these tests pin the exclusivity rather than the appearance.
//
// The other rule pinned here is that popping out is NOT remembered. A reload
// cannot re-find a window it opened, so persisting 'popout' would mean starting
// up pointing at a window that may have gone, with chat reachable from nowhere.
// The saved placement must survive untouched underneath, which is also what
// lets "bring it back" return chat to the rail if that is where it came from.
//
// Both routes (picture-in-picture where the browser has it, a plain second
// window everywhere else) are deliberately interchangeable from the app's point
// of view, and picture-in-picture cannot open in a headless browser at all —
// so these tests force the plain-window route, which is the same fall-through a
// Safari user takes.
//
// ⚠ Assert STRUCTURE, never wording.

import { test, expect, type Page } from '@playwright/test'

const PLACEMENT_KEY = 'pv:chat-placement'

// Stand in for the browser's window handling: remove picture-in-picture so the
// plain-window route is taken, and hand back a fake window that reports itself
// open (the app polls `closed` to notice a window that has gone).
async function stubWindowOpening(page: Page) {
  await page.addInitScript(() => {
    delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture
    const state = { urls: [] as string[], focused: 0 }
    const fake = {
      closed: false,
      focus() {
        state.focused += 1
      },
      close() {
        fake.closed = true
      },
    }
    ;(window as unknown as { __popout: typeof state }).__popout = state
    window.open = ((url?: string | URL) => {
      state.urls.push(String(url ?? ''))
      return fake as unknown as Window
    }) as typeof window.open
  })
}

function chatPill(page: Page) {
  return page.getByRole('button', { name: /^Team chat/ })
}
function chatDropdown(page: Page) {
  return page.getByRole('dialog', { name: 'Team chat' })
}
function dock(page: Page) {
  return page.locator('#team-chat-dock')
}
function popoutState(page: Page) {
  return page.evaluate(() => (window as unknown as { __popout: { urls: string[]; focused: number } }).__popout)
}

test.beforeEach(async ({ page }) => {
  await stubWindowOpening(page)
  await page.goto('/verify-harness/index.html?path=/dashboard')
})

test('the chat dropdown offers a window of its own', async ({ page }) => {
  await chatPill(page).click()
  await expect(chatDropdown(page)).toBeVisible()
  await expect(chatDropdown(page).getByRole('button', { name: /pop chat out/i })).toBeVisible()
})

test('popping out takes the panel out of the page and opens a chat window', async ({ page }) => {
  await chatPill(page).click()
  await chatDropdown(page).getByRole('button', { name: /pop chat out/i }).click()

  // The dropdown must close, or the same conversation is live in two places.
  await expect(chatDropdown(page)).toBeHidden()

  const state = await popoutState(page)
  expect(state.urls).toHaveLength(1)
  // Whatever the window's address is, it has to carry the marker that tells
  // that window it is the popout — that is what makes it drop the app chrome
  // and what stops both windows chiming for the same message.
  expect(state.urls[0]).toContain('popout=1')
})

test('the header button then reaches the window instead of opening a second copy', async ({ page }) => {
  await chatPill(page).click()
  await chatDropdown(page).getByRole('button', { name: /pop chat out/i }).click()
  await expect(chatDropdown(page)).toBeHidden()

  await chatPill(page).click()

  // Still nothing in the page, and no second window: the click brought the
  // existing one forward.
  await expect(chatDropdown(page)).toBeHidden()
  const state = await popoutState(page)
  expect(state.urls).toHaveLength(1)
  expect(state.focused).toBeGreaterThan(0)
})

test('a docked chat pops out too, and leaves the rail empty while it does', async ({ page }) => {
  await chatPill(page).click()
  await chatDropdown(page).getByRole('button', { name: /dock chat to the dashboard sidebar/i }).click()
  await expect(dock(page)).toBeVisible()

  await dock(page).getByRole('button', { name: /pop chat out/i }).click()

  // Chat is in the window now, so it must be in neither of the other two homes.
  await expect(dock(page)).toBeHidden()
  await expect(chatDropdown(page)).toBeHidden()
  expect((await popoutState(page)).urls).toHaveLength(1)
})

test('popping out never overwrites where chat is remembered to live', async ({ page }) => {
  await chatPill(page).click()
  await chatDropdown(page).getByRole('button', { name: /dock chat to the dashboard sidebar/i }).click()
  await expect(dock(page)).toBeVisible()
  expect(await page.evaluate((k) => localStorage.getItem(k), PLACEMENT_KEY)).toBe('docked')

  await dock(page).getByRole('button', { name: /pop chat out/i }).click()
  await expect(dock(page)).toBeHidden()

  // The saved placement is untouched, so a reload comes back to the rail
  // rather than to a window that may no longer exist.
  expect(await page.evaluate((k) => localStorage.getItem(k), PLACEMENT_KEY)).toBe('docked')
  await page.reload()
  await expect(dock(page)).toBeVisible()
})
