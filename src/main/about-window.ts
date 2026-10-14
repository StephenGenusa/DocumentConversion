import { app, BrowserWindow, session, type Session } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { escapeHtml } from '../core/shell'
import { PRODUCT_NAME, appTitle } from './app-identity'

/** One shipped component, as scripts/build-notices.mjs writes it. */
export interface NoticeComponent {
  name: string
  version: string
  license: string
  note?: string
  texts: { file: string; text: string }[]
}

export interface AboutInputs {
  name: string
  version: string
  /** The app's own licence text, or null when notices were never generated. */
  appLicense: string | null
  components: NoticeComponent[]
  electronVersion: string
  electronLicense: string | null
  /** LICENSES.chromium.html as shipped with Electron, or null if it cannot be found. */
  chromiumHtml: string | null
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #5f6368; --rule: #d9d9de; --bg: #ffffff; --code: #f5f5f7; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8ed; --muted: #a1a1aa; --rule: #3a3a40; --bg: #1c1c1f; --code: #26262a; } }
body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--fg); background: var(--bg); margin: 0 auto; max-width: 820px; padding: 24px 28px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 32px 0 8px; padding-top: 12px; border-top: 1px solid var(--rule); }
.muted { color: var(--muted); }
nav ul { padding-left: 20px; }
pre { white-space: pre-wrap; word-wrap: break-word; font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace; background: var(--code); padding: 10px 12px; border-radius: 6px; }
details { border-bottom: 1px solid var(--rule); padding: 6px 0; }
summary { cursor: pointer; }
summary .license { color: var(--muted); }
details.chromium .product { margin: 10px 0; }
details.chromium .title { font-weight: 600; }
details.chromium .homepage { margin-left: 8px; }
details.chromium label, details.chromium #print-link, details.chromium .page-title { display: none; }
`

/**
 * The body of Electron's LICENSES.chromium.html, made inert.
 *
 * The window shows it with JavaScript off and the network off, so nothing in
 * it can run or load; stripping scripts and stylesheet links as well keeps the
 * page from even asking. Its own styles live at chrome:// URLs that would never
 * load here, so it is styled by STYLE instead.
 */
export function chromiumBody(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html
  return body
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
}

/**
 * One page, one scroll: the app and its licence, then every third-party
 * component in its own <details>, then Electron, then Chromium's notices
 * COLLAPSED. That file is 20 MB, and a closed <details> skips laying it out;
 * measured at ~110 ms to load in a JS-off window. Anchors in the contents
 * list work without JavaScript.
 */
export function buildAboutHtml(a: AboutInputs): string {
  const title = `About ${a.name} ${a.version}`
  const parts: string[] = []
  parts.push(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>`)
  parts.push(`<h1 id="top">${escapeHtml(a.name)} ${escapeHtml(a.version)}</h1>`)
  parts.push('<p class="muted">Converts documents on your own computer. Your documents are never uploaded.</p>')
  parts.push(
    '<nav><ul>' +
      '<li><a href="#app">Licence</a></li>' +
      `<li><a href="#third-party">Third-party software (${a.components.length})</a></li>` +
      '<li><a href="#electron">Electron</a></li>' +
      '<li><a href="#chromium">Chromium</a></li>' +
      '</ul></nav>',
  )
  parts.push('<h2 id="app">Licence</h2>')
  parts.push(
    a.appLicense
      ? `<pre>${escapeHtml(a.appLicense)}</pre>`
      : '<p>The licence notices were not generated for this build. Run <code>npm run build</code>.</p>',
  )
  parts.push(`<h2 id="third-party">Third-party software</h2>`)
  parts.push(`<p class="muted">${a.components.length} components ship with this application. Each is listed with the licence it is used under and its licence text.</p>`)
  for (const c of a.components) {
    parts.push(
      `<details><summary>${escapeHtml(c.name)} ${escapeHtml(c.version)} <span class="license">${escapeHtml(c.license)}</span></summary>` +
        (c.note ? `<p class="muted">${escapeHtml(c.note)}</p>` : '') +
        c.texts.map((t) => `<pre>${escapeHtml(t.text)}</pre>`).join('') +
        '</details>',
    )
  }
  parts.push(`<h2 id="electron">Electron ${escapeHtml(a.electronVersion)}</h2>`)
  parts.push(a.electronLicense ? `<pre>${escapeHtml(a.electronLicense)}</pre>` : '<p>Electron\'s licence file was not found beside the application.</p>')
  parts.push('<h2 id="chromium">Chromium</h2>')
  parts.push(
    a.chromiumHtml
      ? `<details class="chromium"><summary>Chromium open-source notices</summary>${chromiumBody(a.chromiumHtml)}</details>`
      : '<p>The Chromium notices file (LICENSES.chromium.html) was not found beside the application.</p>',
  )
  parts.push('</body></html>')
  return parts.join('\n')
}

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => existsSync(p)) ?? null
}

/**
 * Where things are, packaged and in development.
 *
 * Notices are generated into resources/notices and packed with resources/**;
 * see ocr-host.ts for why several roots are tried. Electron's own notices sit
 * beside the executable: LICENSE.electron.txt and LICENSES.chromium.html in a
 * Windows or Linux package, LICENSE and LICENSES.chromium.html in
 * node_modules/electron/dist during development. The macOS layout is tried
 * but has not been verified; a missing file is reported on the page, never
 * an error.
 */
function loadInputs(): AboutInputs {
  const noticesFile = firstExisting([
    join(app.getAppPath(), 'resources', 'notices', 'notices.json'),
    join(__dirname, '..', '..', 'resources', 'notices', 'notices.json'),
    join(process.cwd(), 'resources', 'notices', 'notices.json'),
  ])
  let appLicense: string | null = null
  let components: NoticeComponent[] = []
  if (noticesFile) {
    try {
      const notices = JSON.parse(readFileSync(noticesFile, 'utf8')) as { app: { license: string }; components: NoticeComponent[] }
      appLicense = notices.app.license
      components = notices.components
    } catch {
      /* unreadable: shown as not generated */
    }
  }
  const exeDir = dirname(process.execPath)
  const besideApp = [exeDir, process.resourcesPath, join(process.resourcesPath, '..'), join(exeDir, '..', '..', '..')]
  const electronLicense = firstExisting(besideApp.flatMap((d) => [join(d, 'LICENSE.electron.txt'), join(d, 'LICENSE')]))
  const chromium = firstExisting(besideApp.map((d) => join(d, 'LICENSES.chromium.html')))
  const read = (p: string | null): string | null => {
    try {
      return p ? readFileSync(p, 'utf8') : null
    } catch {
      return null
    }
  }
  return {
    name: PRODUCT_NAME,
    version: app.getVersion(),
    appLicense,
    components,
    electronVersion: process.versions.electron ?? '',
    electronLicense: read(electronLicense)?.trim() ?? null,
    chromiumHtml: read(chromium),
  }
}

/**
 * The About window's session, cut off from everything but its own page.
 *
 * The page is built from text that ships with the app, but most of it was
 * written by third parties (and the Chromium file links all over the web), so
 * it gets what the print window gets: no JavaScript, no network, no navigation.
 */
let aboutSession: Session | undefined
let allowedUrl = ''
function offlineAboutSession(): Session {
  if (!aboutSession) {
    aboutSession = session.fromPartition('docconv-about')
    aboutSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: details.url.split('#')[0] !== allowedUrl })
    })
  }
  return aboutSession
}

let aboutWindow: BrowserWindow | null = null

export async function openAboutWindow(): Promise<void> {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus()
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'docconv-about-'))
  const file = join(dir, 'about.html')
  await writeFile(file, buildAboutHtml(loadInputs()), 'utf8')
  allowedUrl = pathToFileURL(file).href
  const win = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 420,
    minHeight: 320,
    title: `About ${appTitle()}`,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, javascript: false, contextIsolation: true, webSecurity: true, session: offlineAboutSession() },
  })
  aboutWindow = win
  win.setMenu(null)
  win.on('page-title-updated', (e) => e.preventDefault())
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (aboutWindow === win) aboutWindow = null
    void rm(dir, { recursive: true, force: true })
  })
  await win.loadFile(file)
}
