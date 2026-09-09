/**
 * Capture the README screenshots from the real app.
 *
 * Screens are driven through the Chrome DevTools Protocol, but they are NOT
 * captured through it: `Page.captureScreenshot` only ever sees the renderer's
 * own surface, so it cannot show the title bar or the window border, and it
 * pads whatever the emulated viewport does not fill with dead space. Instead
 * this script
 *
 *   1. drives the renderer over CDP as before,
 *   2. measures the laid-out content and resizes the REAL window to fit it, so
 *      there is no empty margin and no scrollbar hiding a control, and
 *   3. captures the window's own drawable — frame included, nothing else's
 *      pixels — rather than cropping a photograph of the screen.
 *
 *   npm run build && npm run screenshots
 *
 * Requirements: X11 and ImageMagick's `import` (Debian/Ubuntu: imagemagick).
 * A window manager must be running, because the title bar and border are drawn
 * by the WM, not by the app — under bare `xvfb-run` the app is undecorated and
 * the captures come out frameless. Run it on a real desktop session.
 *
 * Output: docs/screenshots/*.png, committed. They were briefly gitignored and
 * destined for Release assets, to keep regeneration out of the diff — but that
 * makes the README's images unresolvable until a release exists, which is
 * backwards for the first thing a visitor sees. Committed images work on the
 * first push, and regenerating them is rare enough that the churn is cheap.
 */
import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'screenshots')

/** Renderer CDP, and the main process's own inspector — we need both. */
const PORT = 9333
const INSPECT = 9229

/**
 * Content width of the window. The app column is `max-width: 640px` and
 * centred, so this leaves a deliberate ~30px gutter either side rather than
 * pinning the layout hard against the frame.
 */
const WINDOW_WIDTH = 1000
/** Tall enough to show a document in the edit pane without it feeling cramped. */
const WINDOW_HEIGHT = 900
/** The window's own minimums, from `new BrowserWindow(...)`. */
const MIN_WIDTH = 560
const MIN_HEIGHT = 480
/** Where to park the window, so the crop is deterministic and fully on screen. */
const WINDOW_POS = [80, 80]

/* ------------------------------------------------------------------ *
 * A minimal CDP client. No dependency: Node has had a global WebSocket
 * since 22, and the app is already an Electron we can point at.
 * ------------------------------------------------------------------ */
async function connect(port, type, what) {
  let url
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = list.find((t) => t.type === type && t.webSocketDebuggerUrl)
      if (target) {
        url = target.webSocketDebuggerUrl
        break
      }
    } catch {
      /* not listening yet */
    }
    await sleep(500)
  }
  if (!url) throw new Error(`the app never exposed a CDP ${what} target`)

  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error(`could not open the CDP socket for ${what}`))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    pending.get(msg.id)?.(msg)
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id
      pending.set(n, resolve)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  return { ws, send }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi)

function evaluator(send, where, extra = {}) {
  return async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...extra,
    })
    const thrown = r.result?.exceptionDetails
    if (thrown) throw new Error(`${where} threw: ${JSON.stringify(thrown).slice(0, 300)}`)
    return r.result?.result?.value
  }
}

/* ------------------------------------------------------------------ *
 * Driving the main process. `includeCommandLineAPI` is what puts
 * `require` in scope inside the inspector's evaluation context.
 * ------------------------------------------------------------------ */
function makeWindowControl(evaluate) {
  const call = (body) =>
    evaluate(`(() => {
      const { BrowserWindow, screen } = require('electron');
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (!win) throw new Error('no window');
      ${body}
    })()`)

  return {
    /** Park the window somewhere known, unmaximized and on top of the stack. */
    place: () =>
      call(`
        if (win.isMaximized()) win.unmaximize();
        win.setPosition(${WINDOW_POS[0]}, ${WINDOW_POS[1]});
        win.show();
        win.focus();
        win.moveTop();
        return true;
      `),

    setContentSize: (w, h) => call(`win.setContentSize(${w}, ${h}); return true;`),

    /**
     * The window's X11 id.
     *
     * The frame geometry deliberately does NOT come from `getBounds()`: under
     * mutter that returns the client rectangle, decorations excluded, so
     * cropping to it produces a frameless screenshot. Ask X instead — see
     * `windowTarget` below. The handle is a 32-bit XID in a native-endian buffer.
     */
    xid: () => call('return win.getNativeWindowHandle().readUInt32LE(0);'),

    /** Room available for the window, in device-independent pixels. */
    workArea: () =>
      call(`
        const b = win.getBounds();
        const { workArea } = screen.getDisplayMatching(b);
        return workArea;
      `),
  }
}

/* ------------------------------------------------------------------ *
 * Driving the renderer
 * ------------------------------------------------------------------ */
function makeDriver(evaluate) {
  /** Wait for text to appear on screen, so captures never race the render. */
  const waitForText = async (pattern) => {
    const found = await evaluate(`new Promise((resolve) => {
      let tries = 0
      const tick = () => {
        if (${pattern}.test(document.body.innerText)) return resolve(true)
        if (++tries > 120) return resolve(false)
        setTimeout(tick, 250)
      }
      tick()
    })`)
    if (!found) throw new Error(`timed out waiting for ${pattern}`)
  }

  /** The element React listens on, whichever screen we are currently showing. */
  const TARGET = "(document.querySelector('.dropzone') || document.querySelector('.app__main'))"

  const paste = (text) =>
    evaluate(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(text)});
      ${TARGET}.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`)

  const dropFile = (fileUrl) =>
    evaluate(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/uri-list', ${JSON.stringify(fileUrl)});
      ${TARGET}.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`)

  const clickButton = (label) =>
    evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => ${label}.test(x.textContent.trim()));
      if (!b) throw new Error('no button matching ' + ${label});
      b.click();
    })()`)

  const typeInto = (selector, value) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('no element ' + ${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)

  /**
   * What the window would have to be for the page to fit exactly.
   *
   * `scrollHeight` is useless for shrinking — it is floored at the viewport
   * height, so a half-empty page reports itself as full. The app column's own
   * laid-out box is the honest measure, and its `padding: 2rem 1.5rem` already
   * supplies the bottom margin.
   */
  const contentSize = () =>
    evaluate(`(() => {
      const de = document.documentElement;
      const app = document.querySelector('.app');
      if (!app) return { height: de.scrollHeight, overflowX: false, viewport: { width: de.clientWidth, height: de.clientHeight } };
      /*
       * The app column now fills the viewport by design - it is a flex column
       * with height:100% so the edit pane can take the space left over. That
       * makes its own height useless as a measure of how much content there
       * is: it always equals the window.
       *
       * So measure the PARTS instead - the header, plus how tall the main
       * region's content actually wants to be - and add the column's padding.
       */
      const style = getComputedStyle(app);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const header = document.querySelector('.app__header');
      const main = document.querySelector('.app__main');
      const wanted =
        (header ? header.getBoundingClientRect().height : 0) +
        (main ? main.scrollHeight : 0) +
        padding +
        /* the gap between header and main */ 16;
      return {
        height: Math.ceil(wanted),
        overflowX: de.scrollWidth > de.clientWidth,
        viewport: { width: de.clientWidth, height: de.clientHeight },
      };
    })()`)

  const reset = async () => {
    await evaluate('location.reload()').catch(() => {})
    await sleep(2500)
    await waitForText('/Drop files or text here/')
  }

  return { evaluate, waitForText, paste, dropFile, clickButton, typeInto, contentSize, reset }
}

/**
 * Size the window for a capture.
 *
 * This used to measure the laid-out content and fit the window to it, because
 * the app column was a fixed 640px and anything larger left dead space. The
 * layout is responsive now - every panel fills the window it is given - so
 * there is nothing to fit to, and trying is actively wrong: the edit pane is
 * `flex: 1`, so shrinking the window shrinks the pane, which shrinks the
 * measured content, which shrinks the window again. That loop has no fixed
 * point, and the fit routine ran to its iteration limit every time.
 *
 * A fixed size it is. Chosen to show the panels at a size someone would
 * actually use, rather than the smallest one that happens to fit.
 */
async function fitWindow(win, _d, area) {
  const width = clamp(WINDOW_WIDTH, MIN_WIDTH, Math.max(MIN_WIDTH, area.width - WINDOW_POS[0] - 40))
  const height = clamp(WINDOW_HEIGHT, MIN_HEIGHT, Math.max(MIN_HEIGHT, area.height - WINDOW_POS[1] - 40))
  await win.setContentSize(width, height)
  await sleep(350)
  return { width, height }
}

async function windowTarget(xid) {
  const id = `0x${xid.toString(16)}`
  const { stdout: info } = await run('xwininfo', ['-id', id])
  const num = (label) => {
    const m = info.match(new RegExp(`${label}:\\s+(-?\\d+)`))
    if (!m) throw new Error(`xwininfo did not report ${label}`)
    return Number(m[1])
  }
  const width = num('Width')
  const height = num('Height')
  const relX = num('Relative upper-left X')
  const relY = num('Relative upper-left Y')

  const { stdout: tree } = await run('xwininfo', ['-id', id, '-tree'])
  const parent = tree.match(/Parent window id:\s+(0x[0-9a-f]+)/i)?.[1]
  const root = tree.match(/Root window id:\s+(0x[0-9a-f]+)/i)?.[1]

  // Undecorated — no WM, or a WM that does not reparent. Take the client whole.
  if (!parent || parent === root) return { drawable: id, crop: null }

  let [left, right, top, bottom] = [0, 0, 0, 0]
  try {
    const { stdout } = await run('xprop', ['-id', id, '_NET_FRAME_EXTENTS'])
    const m = stdout.match(/=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/)
    if (m) [left, right, top, bottom] = m.slice(1, 5).map(Number)
  } catch {
    /* property absent — treat the frame as having no visible decoration */
  }

  return {
    drawable: parent,
    crop: `${width + left + right}x${height + top + bottom}+${Math.max(0, relX - left)}+${Math.max(0, relY - top)}`,
  }
}

async function capture(win, name) {
  const { drawable, crop } = await windowTarget(await win.xid())
  const file = join(OUT, `${name}.png`)

  const args = ['-silent', '-window', drawable]
  if (crop) args.push('-crop', crop, '+repage')
  await run('import', [...args, file])
  const { stdout } = await run('identify', ['-format', '%wx%h %B', file])
  const [dims, bytes] = stdout.trim().split(' ')
  console.log(`  ✓ ${name}.png  (${dims}, ${Math.round(Number(bytes) / 1024)} KB)`)
}

/** The X utilities are the only things here that are not project dependencies. */
async function requireTools() {
  for (const [tool, pkg] of [
    ['import', 'ImageMagick (apt install imagemagick)'],
    ['identify', 'ImageMagick (apt install imagemagick)'],
    ['xwininfo', 'x11-utils (apt install x11-utils)'],
    ['xprop', 'x11-utils (apt install x11-utils)'],
  ]) {
    try {
      await run(tool, ['-version'])
    } catch {
      throw new Error(`${tool} is missing — install ${pkg}`)
    }
  }
  if (!process.env.DISPLAY) throw new Error('no DISPLAY; this needs a real X session, not a headless build')
  try {
    const { stdout } = await run('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'])
    if (/not found/i.test(stdout)) throw new Error('no wm')
  } catch {
    console.warn('  ! no window manager detected — captures will have no title bar or border')
  }
}

/* ------------------------------------------------------------------ *
 * The sample content. Deliberately generic — no real document is used,
 * so the screenshots can be published and are identical for anyone who
 * runs this.
 * ------------------------------------------------------------------ */
/**
 * Kept short on purpose: the edit pane is `max-height: 26rem` and scrolls, so
 * a longer sample would put the bottom of the table under the fold and the
 * screenshot would show a clipped table where it means to show a real one.
 */
const SAMPLE_MARKDOWN = `# Reading Group Notes

Converted **offline**, with *formatting* kept.

- Structure is preserved, not flattened
- Tables become real tables

| Title | Copies | Status |
|---|---|---|
| The Long Winter | 24 | On shelf |
| Salt and Rain | 31 | Reserved |
`

const SAMPLE_DOC = `# Branch Notes

A short document used to show the conversion options.
`

async function main() {
  await requireTools()
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  // A file on disk, so the "conversion options" screen has a real input. It
  // lives in a temp directory, not in OUT: its name is visible in the shot, and
  // it must not be mistaken for a screenshot when the directory is published.
  const scratch = await mkdtemp(join(tmpdir(), 'docconversion-shots-'))
  const sample = join(scratch, 'Branch Notes.md')
  await writeFile(sample, SAMPLE_DOC)

  console.log('Launching the app…')
  // Spawned directly rather than through `npx`, and in its own process group:
  // npx sits between us and Electron, so killing it left the app running and
  // every run stacked another orphaned window on the desktop.
  const { default: electronBinary } = await import('electron')
  const app = spawn(
    electronBinary,
    ['.', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`],
    { cwd: ROOT, stdio: 'ignore', detached: process.platform !== 'win32' },
  )
  const stop = () => {
    try {
      if (process.platform === 'win32') app.kill()
      else process.kill(-app.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }

  let sockets = []
  try {
    const page = await connect(PORT, 'page', 'renderer')
    const node = await connect(INSPECT, 'node', 'main process')
    sockets = [page.ws, node.ws]

    await page.send('Page.enable')
    await page.send('Runtime.enable')
    const d = makeDriver(evaluator(page.send, 'the renderer'))
    const win = makeWindowControl(
      evaluator(node.send, 'the main process', { includeCommandLineAPI: true }),
    )

    await win.place()
    const area = await win.workArea()

    /** Every screen is fitted to its own content before it is captured. */
    const shoot = async (name) => {
      await fitWindow(win, d, area)
      await win.place()
      await sleep(400)
      await capture(win, name)
    }

    console.log('Capturing screens…')
    await d.waitForText('/Drop files or text here/')
    await sleep(600)
    await shoot('01-start')

    // 2. Fetching a web page. The URL is typed but NOT submitted: an actual
    //    fetch would need the network, which would make this script flaky and
    //    the screenshot different every run.
    await d.clickButton('/From URL/i')
    await sleep(400)
    await d.typeInto('.dropzone__url input', 'https://example.com/an-article')
    await sleep(400)
    await shoot('02-from-url')

    // 3. The edit pane, with pasted Markdown rendered as formatted text.
    await d.reset()
    await d.paste(SAMPLE_MARKDOWN)
    await d.waitForText('/Reading Group Notes/')
    await sleep(1200)
    await shoot('03-editor')

    // 4. The conversion options, with the PDF page setup showing.
    await d.reset()
    await d.dropFile(`file://${sample.split(/[\\/]/).map(encodeURIComponent).join('/')}`)
    await d.waitForText('/Convert to/i')
    await sleep(900)
    await shoot('04-convert-options')

    console.log(`\nDone. ${OUT}`)
  } finally {
    for (const ws of sockets) ws?.close()
    stop()
    await rm(scratch, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`\nscreenshots failed: ${err.message}`)
  process.exitCode = 1
})
