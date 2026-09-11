// Captures a web page for a canvas "网页参考" card: a full-page screenshot plus the page
// code as the browser rendered it (many sites build their markup with scripts, so a plain
// fetch would only see a shell). Drives the local Chrome / Edge through puppeteer-core;
// set COWART_BROWSER_PATH to use another Chromium-based browser. (Edge 152 on Windows
// can exit right away in headless mode, so Chrome is tried first and a failed launch
// falls through to the next browser.)
import { existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import puppeteer from 'puppeteer-core'

import { pageAssetUrl, pageDirName, resolveCowartPaths } from '../../mcp/lib/canvas-storage.mjs'
import { uniqueFilePath } from './files.mjs'

export const CAPTURE_WEB_TOOL = 'capture_cowart_web_reference'

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
}
// Chromium cannot paint a single capture much taller than this.
const MAX_CAPTURE_HEIGHT = 16000
const NAVIGATION_TIMEOUT_MS = 45000
const SETTLE_MS = 800
const MAX_HTML_BYTES = 8 * 1024 * 1024

// Listed by the adapters as a page-only tool: the canvas calls it, the model never sees it.
export const captureWebTool = {
  name: CAPTURE_WEB_TOOL,
  title: 'Capture Cowart Web Reference',
  description:
    'Used by the Cowart canvas: opens a web page in a local browser, saves a full-page screenshot and the rendered page code into the page assets, and returns them for a web reference card.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      pageId: { type: 'string' },
      viewport: { type: 'string', enum: Object.keys(VIEWPORTS) },
      projectDir: { type: 'string' },
      canvasDir: { type: 'string' }
    },
    required: ['url']
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true }
}

function browserCandidates() {
  const env = process.env
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
    return [
      ...roots.map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map((root) => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    ]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
}

export function findBrowsers() {
  const configured = process.env.COWART_BROWSER_PATH
  const found = browserCandidates().filter((candidate) => existsSync(candidate))
  return [...new Set([...(configured && existsSync(configured) ? [configured] : []), ...found])]
}

async function launchBrowser(view) {
  const browsers = findBrowsers()
  if (browsers.length === 0) throw new Error('找不到本机的 Chrome / Edge，截不了网页；可以用 COWART_BROWSER_PATH 指定浏览器路径。')
  const failures = []
  for (const executablePath of browsers) {
    try {
      return await puppeteer.launch({
        executablePath,
        headless: true,
        defaultViewport: view,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio']
      })
    } catch (error) {
      failures.push(`${executablePath}：${error.message.split('\n')[0]}`)
    }
  }
  throw new Error(`本机浏览器都没能以无头模式启动，截不了网页。${failures.join('；')}`)
}

// Accepts what people paste: a bare domain gets https://.
export function normalizeWebUrl(value) {
  const text = String(value || '').trim()
  if (!text) throw new Error('网址是空的。')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`这不是一个网址：${text}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只能截 http / https 网页。')
  return url.href
}

function fileStem(url) {
  const host = new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-').slice(0, 48) || 'page'
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')
  return `web-${host}-${stamp}`
}

// Walks down the page so lazy images and scroll-triggered content load before the capture.
async function scrollThrough(page) {
  await page.evaluate(async (maxHeight) => {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.85))
    for (let y = 0; y < Math.min(document.documentElement.scrollHeight, maxHeight); y += step) {
      window.scrollTo(0, y)
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    window.scrollTo(0, 0)
  }, MAX_CAPTURE_HEIGHT)
}

export async function captureWebPage({ url, dir, viewport = 'desktop' }) {
  const view = VIEWPORTS[viewport] || VIEWPORTS.desktop
  const browser = await launchBrowser(view)
  try {
    const page = await browser.newPage()
    // Some sites turn away "HeadlessChrome".
    await page.setUserAgent({ userAgent: (await browser.userAgent()).replace('HeadlessChrome', 'Chrome') })
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT_MS })
    } catch (error) {
      // A page that never goes quiet still gets captured as far as it loaded.
      if (!/timeout/i.test(error.message) || page.url() === 'about:blank') throw new Error(`打不开这个网址：${error.message}`)
    }
    await scrollThrough(page)
    await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => null)
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

    const fullHeight = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight)
    )
    const height = Math.min(fullHeight, MAX_CAPTURE_HEIGHT)
    const stem = fileStem(page.url() || url)
    await mkdir(dir, { recursive: true })
    const shot = await uniqueFilePath(dir, `${stem}.png`)
    await page.screenshot({
      path: shot.filePath,
      type: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: view.width, height }
    })

    let html = await page.content()
    const truncatedHtml = Buffer.byteLength(html) > MAX_HTML_BYTES
    if (truncatedHtml) html = html.slice(0, MAX_HTML_BYTES)
    const code = await uniqueFilePath(dir, `${stem}.html`)
    await writeFile(code.filePath, html)

    return {
      finalUrl: page.url(),
      title: (await page.title()).trim(),
      viewport,
      width: view.width,
      height,
      fullHeight,
      pixelRatio: view.deviceScaleFactor || 1,
      truncated: fullHeight > height,
      truncatedHtml,
      screenshot: { fileName: shot.fileName, path: shot.filePath },
      html: { fileName: code.fileName, path: code.filePath }
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

// Called for the page-only capture tool: files go next to the page's other assets.
export async function captureWebReference({ args = {} }) {
  const url = normalizeWebUrl(args.url)
  const { canvasDir } = resolveCowartPaths(args)
  const pageId = typeof args.pageId === 'string' && args.pageId.startsWith('page:') ? args.pageId : 'page:page'
  const dir = join(canvasDir, 'pages', pageDirName(pageId), 'assets')
  const capture = await captureWebPage({ url, dir, viewport: args.viewport })
  const fileSize = (await stat(capture.screenshot.path)).size
  return {
    url: capture.finalUrl || url,
    requestedUrl: url,
    title: capture.title,
    capturedAt: new Date().toISOString(),
    viewport: capture.viewport,
    // CSS pixels (the card's size on the canvas) and the image's own pixels.
    width: capture.width,
    height: capture.height,
    imageWidth: capture.width * capture.pixelRatio,
    imageHeight: capture.height * capture.pixelRatio,
    fullHeight: capture.fullHeight,
    pixelRatio: capture.pixelRatio,
    truncated: capture.truncated,
    screenshot: { ...capture.screenshot, assetUrl: pageAssetUrl(pageId, capture.screenshot.fileName), fileSize, mimeType: 'image/png' },
    html: { ...capture.html, assetUrl: pageAssetUrl(pageId, capture.html.fileName) }
  }
}
