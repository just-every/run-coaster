import { chromium } from '@playwright/test'
import { checkoutPlaywright } from '@runeditrun/rer/internal/cli/browser-runtime.mjs'

const { playwright } = checkoutPlaywright(process.cwd())
for (const engine of new Set([chromium, playwright.chromium])) {
  const browser = await engine.launch({
    headless: true,
    ...(process.platform === 'darwin' ? { args: ['--use-mock-keychain', '--password-store=basic'] } : {}),
  })
  await browser.close()
}
