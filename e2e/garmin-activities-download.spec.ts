import { test as base, expect, chromium } from '@playwright/test'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env') })

const CHROME_PROFILE = `${process.env.HOME}/Library/Application Support/Google/Chrome/Profile 1`

const test = base.extend<{ page: import('@playwright/test').Page }>({
    page: async ({}, use) => {
        const browser = await chromium.launchPersistentContext(CHROME_PROFILE, {
            channel: 'chrome',
            headless: false,
            args: ['--disable-features=Translate'],
        })
        const page = browser.pages()[0] ?? await browser.newPage()
        await use(page)
        await browser.close()
    },
})

function getCredentials(): { email: string; password: string } {
    const email = process.env.GARMIN_EMAIL?.trim() ?? ''
    const password = process.env.GARMIN_PASSWORD?.trim() ?? ''

    if (!email || !password) {
        throw new Error('GARMIN_EMAIL vagy GARMIN_PASSWORD hiányzik a .env fájlból')
    }

    return { email, password }
}

async function ensureActivePage(page: import('@playwright/test').Page) {
    if (!page.isClosed()) return page

    const existing = page.context().pages().find((p) => !p.isClosed())
    return existing ?? page.context().newPage()
}

async function handleCookieConsent(page: import('@playwright/test').Page) {
    page = await ensureActivePage(page)
    // TrustArc süti dialog – iframe-ben van
    const frame = page.frameLocator('iframe[name="trustarc_cm"]')
    const agreeBtn = frame.locator('a.required, a[data-query="agree_all"], a:has-text("Agree"), a:has-text("Accept"), button:has-text("Agree"), button:has-text("Accept")')
    await page.waitForTimeout(3000)
    if (await agreeBtn.first().isVisible({ timeout: 6000 }).catch(() => false)) {
        await page.waitForTimeout(3000) // Rövid várakozás, hogy a gomb tényleg kattintható legyen
        await agreeBtn.first().click()
        await page.waitForTimeout(2000) 
    }
}

async function loginIfNeeded(page: import('@playwright/test').Page) {
    page = await ensureActivePage(page)
    await page.waitForLoadState('domcontentloaded')

    const emailInput = page.locator('input#email[type="email"]')
    if (!await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) return

    const { email, password } = getCredentials()

    await emailInput.fill(email)

    const passwordInput = page.locator('input#password[type="password"]')
    await passwordInput.fill(password)
    await passwordInput.dispatchEvent('input')

    const rememberCheckbox = page.locator('input[name="remember"]')
    if (await rememberCheckbox.isVisible({ timeout: 1000 }).catch(() => false)) {
        await rememberCheckbox.evaluate((el: HTMLInputElement) => {
            el.checked = true
            el.dispatchEvent(new Event('change', { bubbles: true }))
        })
    }

    const submitButton = page.locator('[data-testid="g__button"]')
    await submitButton.waitFor({ state: 'visible' })
    await expect(submitButton).toBeEnabled()

    await submitButton.click()

    await page.waitForTimeout(4000)
    const errorAlert = page.locator('[data-testid="g__alert"]')
    if (await errorAlert.isVisible()) {
        const msg = await errorAlert.innerText()
        const fs = await import('fs')
        fs.writeFileSync('debug-after-login.html', await page.content())
        throw new Error(`Login hiba: ${msg.trim()}`)
    }

    await page.waitForURL(/connect\.garmin\.com\/app\//, { timeout: 30000 }).catch(async (err) => {
        const fs = await import('fs')
        fs.writeFileSync('debug-after-login.html', await page.content())
        console.error('[loginIfNeeded] URL várakozás sikertelen:', page.url())
        throw err
    })

    await page.context().storageState({ path: '.auth/session.json' })
}

test('Sync Activities', async ({ page }) => {
    page = await ensureActivePage(page)
    // Főoldal – itt jelenik meg a TrustArc süti dialog
    await page.goto('https://connect.garmin.com/hu/', { waitUntil: 'domcontentloaded' })
    await handleCookieConsent(page)

    // Továbblépés az activities oldalra (átirányít a loginra ha nincs session)
    page = await ensureActivePage(page)
    await page.goto('https://connect.garmin.com/app/activities', { waitUntil: 'domcontentloaded' })
    await loginIfNeeded(page)

    await expect(page).toHaveURL('https://connect.garmin.com/app/activities')
})
