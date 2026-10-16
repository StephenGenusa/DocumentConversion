/**
 * UI state checks, against the real app.
 *
 * These are the bugs a unit test cannot see, because each one lives in what the
 * window does BETWEEN two conversions:
 *
 *   - a file changed on disk was converted from the bytes read when it was added
 *   - edits made in the pane were thrown away when a result was dismissed
 *   - a file that had been deleted converted anyway, from those same old bytes
 *
 * The app is driven over the Chrome DevTools Protocol and every conversion goes
 * to the clipboard, which needs no save dialog, and is read back from there.
 *
 *   npm run build && npm run test:ui
 *
 * On Linux the app runs under `xvfb-run` when it is installed, so it opens no
 * window and uses that server's clipboard rather than yours. Anywhere else it
 * runs on the real desktop and WILL overwrite the clipboard.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = 9455
const { default: electron } = await import('electron')
const work = mkdtempSync(join(tmpdir(), 'docconv-ui-'))
const profile = mkdtempSync(join(tmpdir(), 'docconv-ui-profile-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MAIN_INSPECT_PORT = 9456
// --inspect opens the MAIN process to the Node inspector: window titles live
// there, not in any page the DevTools protocol can see.
const appArgs = [`--inspect=${MAIN_INSPECT_PORT}`, ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`]
const headless = process.platform === 'linux' && spawnSync('which', ['xvfb-run']).status === 0
// Its own process group: xvfb-run is a shell script, and signalling only it
// leaves Electron and the X server behind.
const app = headless
  ? spawn('xvfb-run', ['-a', electron, ...appArgs], { stdio: 'ignore', detached: true })
  : spawn(electron, appArgs, { stdio: 'ignore' })

let failures = 0
async function finish(code) {
  const exited = app.exitCode !== null ? Promise.resolve() : new Promise((r) => app.once('exit', r))
  try {
    if (headless) process.kill(-app.pid, 'SIGTERM')
    else app.kill()
  } catch {
    /* already gone */
  }
  // Wait for it to go before removing its profile: Electron writes to the
  // profile on the way out, and recreated a folder that was deleted under it.
  await Promise.race([exited, sleep(5000)])
  // Electron's helper processes outlive the one that was waited on, and one
  // of them rewrote the profile after it had been removed. Signal 0 only asks
  // whether anything in the group is left; it throws once nothing is.
  for (let i = 0; headless && i < 50; i++) {
    try {
      process.kill(-app.pid, 0)
    } catch {
      break
    }
    await sleep(100)
  }
  // Never let tidying up turn a pass into a failure.
  for (const dir of [work, profile]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch (err) {
      console.log(`note  could not remove ${dir}: ${err.message}`)
    }
  }
  process.exit(code)
}
const watchdog = setTimeout(() => {
  console.log('FAIL  timed out')
  void finish(1)
}, 180_000)

/* ---------------------------- a minimal CDP client ---------------------------- */

let page
for (let i = 0; i < 80 && !page; i++) {
  await sleep(250)
  try {
    page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page')
  } catch {
    /* not listening yet */
  }
}
if (!page) {
  console.log('FAIL  the app did not start (run `npm run build` first)')
  await finish(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
  }
}
async function js(expression) {
  const id = ++seq
  const res = await new Promise((r) => {
    pending.set(id, r)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400))
  return res.result?.result?.value
}
async function waitFor(expression, what) {
  for (let i = 0; i < 100; i++) {
    if (await js(expression)) return
    await sleep(100)
  }
  throw new Error(`never happened: ${what}`)
}
// The checks run on a real desktop, where another window may hold the
// keyboard focus; the page then gets no focus events (the language picker
// fills its list on focus) and the checks depended on what else was open.
// Chromium's focus emulation has the page behave as the focused window.
await new Promise((r) => {
  const id = ++seq
  pending.set(id, r)
  ws.send(JSON.stringify({ id, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }))
})

/** A one-off DevTools-protocol session on any target (a page, or the main process). */
async function session(wsUrl) {
  const sock = new WebSocket(wsUrl)
  await new Promise((r, j) => {
    sock.onopen = r
    sock.onerror = j
  })
  let n = 0
  const waiting = new Map()
  sock.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && waiting.has(d.id)) {
      waiting.get(d.id)(d)
      waiting.delete(d.id)
    }
  }
  return {
    send: (method, params = {}) =>
      new Promise((r) => {
        const id = ++n
        waiting.set(id, r)
        sock.send(JSON.stringify({ id, method, params }))
      }),
    close: () => sock.close(),
  }
}

/** Evaluate in the Electron main process. */
async function mainEval(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${MAIN_INSPECT_PORT}/json/list`)).json()
  const s = await session(targets[0].webSocketDebuggerUrl)
  try {
    const res = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 300))
    return res.result?.result?.value
  } finally {
    s.close()
  }
}
const windowTitles = () =>
  mainEval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().map((w) => w.getTitle())`)

/* --------------------------------- UI helpers --------------------------------- */

/** With UI_SHOTS=<dir>, a PNG of the window at this point, for a person to look at. */
async function shot(name) {
  if (!process.env.UI_SHOTS) return
  const id = ++seq
  const res = await new Promise((r) => {
    pending.set(id, r)
    ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }))
  })
  mkdirSync(process.env.UI_SHOTS, { recursive: true })
  writeFileSync(join(process.env.UI_SHOTS, `${name}.png`), Buffer.from(res.result.data, 'base64'))
}

const EDITOR = `document.querySelector('.clip-pane__editor .ProseMirror')`
const click = async (label) => {
  const ok = await js(
    `(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if(!b) return false; b.click(); return true })()`,
  )
  if (!ok) throw new Error(`no "${label}" button`)
}
/** A toolbar control drawn as an icon, found by its accessible name. */
const press = async (label) => {
  const ok = await js(`(() => { const b=document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)}); if(!b) return false; b.click(); return true })()`)
  if (!ok) throw new Error(`no "${label}" control`)
}
const editorText = () => js(`${EDITOR}?.textContent ?? null`)
const typeIntoEditor = (html) =>
  js(`(() => { const ed=${EDITOR}.editor; ed.commands.insertContentAt(ed.state.doc.content.size, ${JSON.stringify(html)}) })()`)
const noticeText = () => js(`[...document.querySelectorAll('.app__notice')].map(e=>e.textContent).join(' | ')`)
const windowRegainsFocus = () => js(`window.dispatchEvent(new Event('focus'))`)
const resultIsUp = `!!document.querySelector('.result')`

/** Convert to the clipboard and return what landed there, or the error shown. */
async function convert() {
  await click('Convert to clipboard')
  await waitFor(resultIsUp, 'a result')
  const error = await js(`document.querySelector('.result--err')?.textContent ?? null`)
  if (error !== null) return { error }
  const clip = await js('window.api.readClipboard()')
  return { text: clip.text ?? clip.html ?? '' }
}
const dismiss = async () => {
  await js(`(() => { const b=[...document.querySelectorAll('.result button')].find(b=>['Done','Back'].includes(b.textContent.trim())); b.click() })()`)
  await waitFor(`!document.querySelector('.result')`, 'the result to close')
}
const startOver = async () => {
  await click('Change')
  await waitFor(`!!document.querySelector('.dropzone')`, 'the empty drop zone')
}

/** Write a file with an mtime of its own, so a rewrite is never invisible. */
let tick = 0
function writeAt(path, content) {
  writeFileSync(path, content)
  const when = new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick * 5))
  utimesSync(path, when, when)
}
async function dropFile(path, name) {
  await js(
    `(() => { const dt=new DataTransfer(); dt.setData('text/uri-list', ${JSON.stringify(pathToFileURL(path).href)}); document.querySelector('.dropzone').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true})) })()`,
  )
  await waitFor(`[...document.querySelectorAll('.card__name')].some(e=>e.textContent.includes(${JSON.stringify(name)}))`, `${name} to load`)
  await click('Markdown')
}
const paste = (selector, text, html) =>
  js(
    `(() => { const dt=new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)}); ${html ? `dt.setData('text/html', ${JSON.stringify(html)});` : ''} document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true})) })()`,
  )

/** The checkbox labelled `text`, as { checked } or null when it is not shown. */
const checkbox = (text) =>
  js(`(() => { const l=[...document.querySelectorAll('label')].find(l=>l.textContent.trim()===${JSON.stringify(text)}); const i=l?.querySelector('input[type=checkbox]'); return i ? { checked: i.checked } : null })()`)
const toggle = async (text) => {
  const before = (await checkbox(text))?.checked
  await js(`[...document.querySelectorAll('label')].find(l=>l.textContent.trim()===${JSON.stringify(text)}).querySelector('input').click()`)
  await waitFor(`[...document.querySelectorAll('label')].find(l=>l.textContent.trim()===${JSON.stringify(text)})?.querySelector('input').checked === ${!before}`, `"${text}" to change`)
}

/** The select labelled `text`, as { value, text } or null when it is not shown. */
const choice = (text) =>
  js(`(() => { const l=[...document.querySelectorAll('label')].find(l=>l.firstChild?.textContent.trim()===${JSON.stringify(text)}); const s=l?.querySelector('select'); return s ? { value: s.value, text: s.selectedOptions[0]?.textContent } : null })()`)
const choose = async (text, value) => {
  await js(`(() => { const s=[...document.querySelectorAll('label')].find(l=>l.firstChild?.textContent.trim()===${JSON.stringify(text)}).querySelector('select'); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change',{bubbles:true})) })()`)
  await waitFor(`[...document.querySelectorAll('label')].find(l=>l.firstChild?.textContent.trim()===${JSON.stringify(text)})?.querySelector('select').value === ${JSON.stringify(value)}`, `"${text}" to change`)
}

function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}\n      ${String(detail).replace(/\n/g, '\\n').slice(0, 300)}`)
  }
}

/* ----------------------------------- checks ----------------------------------- */

try {
  await waitFor(`!!document.querySelector('.dropzone')`, 'the app to load')

  // The window title carries the version; the page's own <title> must not replace it.
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  let titles = await windowTitles()
  check('the window title shows the version', titles.includes(`Document Converter ${version}`), JSON.stringify(titles))

  // About opens from the start screen, in its own window, with Chromium's 20 MB of notices collapsed.
  const opened = Date.now()
  await click('About and licences')
  let about
  for (let i = 0; i < 100 && !about; i++) {
    await sleep(100)
    about = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page' && t.title.startsWith('About '))
  }
  check('About opens in its own window', about?.title === `About Document Converter ${version}`, JSON.stringify(about?.title))
  if (about) {
    console.log(`note  About window appeared after ${Date.now() - opened} ms`)
    // JavaScript is off in that window, so ask the DOM domain, not Runtime.
    const s = await session(about.webSocketDebuggerUrl)
    // The target is listed as soon as <title> is parsed, before the rest of
    // the page. Ask only once the window has finished loading: when the 20 MB
    // page's parsing ends, DevTools replaces its document and every node id
    // handed out before is void, so a query that straddles that moment (the
    // Chromium section is already there, the 20 MB in it is not) finds
    // nothing. Waiting for the Chromium section was not enough: it is parsed
    // before its contents, and under load the swap came mid-query.
    const aboutLoading = () =>
      mainEval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('About '))?.webContents.isLoading() ?? true`)
    for (let i = 0; i < 100 && (await aboutLoading()); i++) await sleep(100)
    console.log(`note  About page fully loaded after ${Date.now() - opened} ms`)
    const doc = (await s.send('DOM.getDocument', { depth: 0 })).result
    const q = async (selector) => (await s.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })).result?.nodeId ?? 0
    const chromium = await q('details.chromium')
    const openChromium = await q('details.chromium[open]')
    const components = await q('details:not(.chromium)')
    const navId = await q('nav')
    const nav = navId ? (await s.send('DOM.getOuterHTML', { nodeId: navId })).result?.outerHTML : ''
    s.close()
    check('About lists the third-party components', components > 0 && !/Third-party software \(0\)/.test(nav), nav)
    check('the Chromium notices are there and start collapsed', chromium > 0 && openChromium === 0, { chromium, openChromium })
    titles = await windowTitles()
    check('the About window title shows the version too', titles.includes(`About Document Converter ${version}`), JSON.stringify(titles))
    await mainEval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('About '))?.close()`)
  }

  // A file is read from disk at every conversion, not once when it is added.
  const live = join(work, 'live.md')
  writeAt(live, '# Version ONE\n')
  await dropFile(live, 'live.md')
  let out = await convert()
  check('a dropped file converts', out.text?.includes('Version ONE'), JSON.stringify(out))
  await dismiss()
  writeAt(live, '# Version TWO\n')
  out = await convert()
  check('a file changed on disk converts as it is now', out.text?.includes('Version TWO'), JSON.stringify(out))
  await dismiss()

  // A file that is gone is an error, never the bytes it used to have.
  unlinkSync(live)
  out = await convert()
  check('a deleted file is reported, by name', /live\.md/.test(out.error ?? '') && /moved, renamed or deleted/.test(out.error ?? ''), JSON.stringify(out))
  await dismiss()
  await startOver()

  // A database with a view: the view's rows are left out until asked for.
  const db = join(work, 'pantry.sqlite')
  const made = spawnSync('python3', ['-I', '-c', [
    'import sqlite3, sys',
    'c = sqlite3.connect(sys.argv[1])',
    "c.execute('CREATE TABLE jars (shelf TEXT, flavour TEXT, jars INTEGER)')",
    "c.executemany('INSERT INTO jars VALUES (?, ?, ?)', [('top', 'quincemarmalade', 3), ('top', 'gooseberryjam', 2), ('low', 'damsonjelly', 5)])",
    "c.execute('CREATE TABLE shelves (shelf TEXT, room TEXT)')",
    "c.execute(\"INSERT INTO shelves VALUES ('top', 'larder')\")",
    "c.execute('CREATE VIEW shelftotals AS SELECT shelf, SUM(jars) AS jarsumzz FROM jars GROUP BY shelf')",
    'c.commit()',
  ].join('\n'), db])
  if (made.status !== 0) throw new Error(`could not make the test database: ${made.stderr}`)
  await dropFile(db, 'pantry.sqlite')
  let box = await checkbox('Include view results')
  check('a database with a view offers "Include view results"', box !== null, JSON.stringify(box))
  check('"Include view results" starts unchecked', box?.checked === false, JSON.stringify(box))
  out = await convert()
  check('without it, the view is left out', out.text?.includes('quincemarmalade') && !/^#+ shelftotals/m.test(out.text ?? ''), JSON.stringify(out))
  await dismiss()
  await toggle('Include view results')
  out = await convert()
  check('with it, the view is converted too', out.text?.includes('quincemarmalade') && /^#+ shelftotals/m.test(out.text ?? '') && /\| *jarsumzz *\|/.test(out.text), JSON.stringify(out))
  await dismiss()
  await startOver()

  // A transcript keeps its cue times unless told not to.
  const vtt = join(work, 'chat.vtt')
  writeAt(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Zorbo Quill>Shall we begin the pickling?\n\n00:00:04.000 --> 00:00:06.500\n<v Mira Vantablue>Only once the jars are warm.\n\n00:00:07.000 --> 00:00:09.000\n<v Zorbo Quill>Warm they are.\n')
  await dropFile(vtt, 'chat.vtt')
  box = await checkbox('Include timestamps')
  check('a transcript offers "Include timestamps"', box !== null, JSON.stringify(box))
  check('"Include timestamps" starts checked', box?.checked === true, JSON.stringify(box))
  out = await convert()
  check('with it, the transcript shows the cue times', /00:00:0[14]/.test(out.text ?? '') && out.text.includes('pickling'), JSON.stringify(out))
  await dismiss()
  await toggle('Include timestamps')
  out = await convert()
  check('without it, the cue times are gone', !/\d\d:\d\d:\d\d/.test(out.text ?? '') && out.text?.includes('pickling'), JSON.stringify(out))
  await dismiss()
  await startOver()

  // Neither checkbox is offered for a file they mean nothing to.
  const plain = join(work, 'plain.md')
  writeAt(plain, '# Nothing to tick\n')
  await dropFile(plain, 'plain.md')
  const boxes = [await checkbox('Include view results'), await checkbox('Include timestamps')]
  check('neither checkbox is offered for a Markdown file', boxes.every((b) => b === null), JSON.stringify(boxes))
  await startOver()

  // The Diagrams choice (spec B4, V1): shown for an output that takes SVG when
  // an input has a diagram, known as soon as the file is added (never opened
  // in the editor); hidden for Word; its value kept while hidden.
  await dropFile(join(ROOT, 'tests', 'corpus', 'diagram-notes.md'), 'diagram-notes.md')
  await click('PDF')
  let diagramsChoice = await choice('Diagrams and formulas')
  check('a file with diagrams, never opened, offers "Diagrams and formulas" for PDF', diagramsChoice !== null, JSON.stringify(diagramsChoice))
  check('"Diagrams and formulas" starts as Sharp (SVG)', diagramsChoice?.value === 'svg' && diagramsChoice?.text === 'Sharp (SVG)', JSON.stringify(diagramsChoice))
  await choose('Diagrams and formulas', 'png')
  await click('Word')
  check('it is not offered for Word', (await choice('Diagrams and formulas')) === null, 'shown for Word')
  await click('PDF')
  diagramsChoice = await choice('Diagrams and formulas')
  check('it keeps its value while hidden', diagramsChoice?.value === 'png', JSON.stringify(diagramsChoice))
  await startOver()
  await dropFile(plain, 'plain.md')
  await click('PDF')
  check('it is not offered for a file with no diagrams', (await choice('Diagrams and formulas')) === null, 'shown')
  await startOver()
  // Graphviz alone is something drawn (step 17), so the choice applies to it.
  await dropFile(join(ROOT, 'tests', 'corpus', 'graphviz-notes.md'), 'graphviz-notes.md')
  await click('PDF')
  check('a Graphviz-only file offers "Diagrams and formulas" for PDF', (await choice('Diagrams and formulas')) !== null, 'not shown')
  await startOver()

  // Diagrams drawn in the editor (spec B11): edit one, see the live preview,
  // close it, and convert to the clipboard as HTML, where it is drawn too.
  await dropFile(join(ROOT, 'tests', 'corpus', 'diagram-notes.md'), 'diagram-notes.md')
  await click('Edit')
  await waitFor(`document.querySelectorAll('.rb[data-state=picture]').length >= 1`, 'the first diagram to be drawn')
  const blockStates = () => js(`[...document.querySelectorAll('.rb')].map((b) => b.dataset.state)`)
  await waitFor(`document.querySelectorAll('.rb')[3]?.dataset.state === 'picture'`, 'the Graphviz diagram to be drawn')
  let states = await blockStates()
  check('the editor draws the Mermaid and Graphviz diagrams, and shows the broken one with its message', states[0] === 'picture' && states[2] === 'error' && states[3] === 'picture', JSON.stringify(states))
  const dotPicture = await js(`(() => {
    const img = document.querySelectorAll('.rb')[3].querySelector('.rb__picture img')
    const src = img?.getAttribute('src') ?? ''
    const svg = src.startsWith('data:image/svg+xml;base64,') ? decodeURIComponent(escape(atob(src.split(',')[1]))) : ''
    return { svg: Boolean(svg), font: /font-family="Arial, &quot;Liberation Sans&quot;, Helvetica, sans-serif"/.test(svg), width: img?.naturalWidth ?? 0, shown: img?.getBoundingClientRect().width ?? 0 }
  })()`)
  check('the Graphviz drawing is an SVG <img> in the pane, labels in the font stack', dotPicture.svg && dotPicture.font && dotPicture.width > 0 && dotPicture.shown > 0, JSON.stringify(dotPicture))
  const firstSrc = () => js(`document.querySelector('.rb .rb__picture img')?.getAttribute('src') ?? null`)
  const before = await firstSrc()
  check('a drawing is an <img> of SVG, never markup in the page', before?.startsWith('data:image/svg+xml;base64,') && (await js(`!document.querySelector('.clip-pane__editor svg')`)), String(before).slice(0, 60))
  await js(`document.querySelector('.rb .rb__picture').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))`)
  await waitFor(`document.querySelector('.rb').dataset.state === 'editing'`, 'the diagram to open for editing')
  await js(`${EDITOR}.editor.commands.insertContent('\\n  H --> Z[Archived]')`)
  await waitFor(`(document.querySelector('.rb .rb__preview img')?.getAttribute('src') ?? ${JSON.stringify(before)}) !== ${JSON.stringify(before)}`, 'the live preview to redraw')
  await js(`${EDITOR}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  await waitFor(`document.querySelector('.rb').dataset.state === 'picture'`, 'the diagram to close')
  check('closing the editor leaves the new drawing in place', (await firstSrc()) !== before, 'unchanged picture')
  await click('HTML')
  await click('Convert to clipboard')
  await waitFor(resultIsUp, 'a result')
  const clip = await mainEval(`(() => { const { clipboard } = process.mainModule.require('electron'); return { html: clipboard.readHTML(), text: clipboard.readText() } })()`)
  // Two Mermaid diagrams and the Graphviz one, and the formula (step 18); the broken diagram stays source.
  const clipPictures = (clip.html.match(/<img[^>]+src="data:image\/png;base64,/g) ?? []).length
  check('converted to the clipboard, the edited diagram is drawn in the HTML', clipPictures === 4 && !clip.html.includes('Archived'), `${clipPictures} pictures: ${clip.html.slice(0, 300)}`)
  check('and is its edited source in the plain text', clip.text.includes('H --> Z[Archived]'), clip.text.slice(0, 300))
  await dismiss()
  await waitFor(`!!${EDITOR}`, 'the edit pane to come back')

  // Insert Diagram (spec B13): drawn at once from its starter; one undo removes it.
  const pane = () => js(`${EDITOR}.editor.getHTML()`)
  const withoutInsert = await pane()
  await press('Diagram')
  await click('Mermaid diagram')
  await waitFor(`!!document.querySelector('.rb[data-state=editing] .rb__preview img')`, 'the inserted diagram to preview')
  check('Insert diagram adds a Mermaid block with a starter', (await pane()).includes('<pre><code class="language-mermaid">flowchart LR\n  A --&gt; B</code></pre>'), await pane())
  await press('Undo')
  check('one undo removes the inserted diagram', (await pane()) === withoutInsert, await pane())
  await startOver()

  // A 500-formula document opens at once (spec B11); diagrams are drawn as they scroll into view.
  const formulas = join(work, 'formulas.md')
  writeAt(formulas, ['# Exercises', ...Array.from({ length: 500 }, (_, i) => `Step ${i}: the value $x_{${i}}^2 + ${i}$ holds.` + (i % 25 === 0 ? `\n\n$$\n\\sum_{k=0}^{${i}} k\n$$` : ''))].join('\n\n'))
  await dropFile(formulas, 'formulas.md')
  const painted = await js(`new Promise((done) => {
    const t0 = performance.now()
    ;[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Edit').click()
    const tick = () => document.querySelector('.clip-pane__editor .ProseMirror') ? requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now() - t0))) : requestAnimationFrame(tick)
    tick()
  })`)
  console.log(`note  500-formula document: Edit to first paint ${Math.round(painted)} ms`)
  check('a 500-formula document opens in the editor at once', painted < 3000 && (await js(`document.querySelectorAll('.clip-pane__editor .rm').length`)) === 500, `${painted} ms`)
  // TeX is drawn (MathJax, step 18): the inline formulas and the display one on screen.
  await waitFor(`document.querySelector('.clip-pane__editor .rm')?.dataset.state === 'picture' && document.querySelector('.clip-pane__editor .rb--math')?.dataset.state === 'picture'`, 'the first formulas to be drawn')
  const mathShown = await js(`(() => {
    const rm = document.querySelector('.clip-pane__editor .rm img')
    const rb = document.querySelector('.clip-pane__editor .rb--math .rb__picture img')
    const svgOf = (img) => (img?.getAttribute('src') ?? '').startsWith('data:image/svg+xml;base64,')
    // The formula's bottom sits below the text's baseline by its depth: compare with the text around it.
    const p = rm?.closest('p')
    const range = document.createRange()
    range.setStart(p.firstChild, 0)
    range.setEnd(p.firstChild, 4)
    const text = range.getBoundingClientRect()
    const box = rm.getBoundingClientRect()
    return { inline: svgOf(rm), display: svgOf(rb), align: rm.style.verticalAlign, inlineH: box.height, textH: text.height, belowText: box.bottom - text.bottom, alt: rm.alt, centred: rb ? Math.abs((rb.getBoundingClientRect().left + rb.getBoundingClientRect().right) / 2 - (rb.closest('.rb').getBoundingClientRect().left + rb.closest('.rb').getBoundingClientRect().right) / 2) : -1 }
  })()`)
  console.log(`note  formula in the pane: ${JSON.stringify(mathShown)}`)
  check('the editor draws inline and display TeX as SVG <img>s, the inline one lowered onto the baseline', mathShown.inline && mathShown.display && /^-[0-9.]+ex$/.test(mathShown.align) && mathShown.alt === 'x_{0}^2 + 0' && mathShown.inlineH > mathShown.textH * 0.6 && mathShown.inlineH < mathShown.textH * 2, JSON.stringify(mathShown))
  await startOver()
  const many = join(work, 'many.md')
  writeAt(many, Array.from({ length: 40 }, (_, i) => `Diagram ${i}.\n\n\`\`\`mermaid\nflowchart LR\n  A${i}[Start ${i}] --> B${i}[End ${i}]\n\`\`\``).join('\n\n'))
  await dropFile(many, 'many.md')
  await click('Edit')
  await waitFor(`document.querySelectorAll('.rb[data-state=picture]').length >= 2`, 'the diagrams on screen to be drawn')
  await sleep(1500)
  states = await blockStates()
  check('only the diagrams on screen and next to it are drawn', states[0] === 'picture' && states.at(-1) === 'waiting' && states.filter((s) => s === 'picture').length < 15, states.join(' '))
  await js(`document.querySelector('.clip-pane__editor').scrollTop = 1e6`)
  await waitFor(`[...document.querySelectorAll('.rb')].at(-1).dataset.state === 'picture'`, 'the last diagram to be drawn on scroll')
  check('scrolling to the end draws the last diagram', true)
  await startOver()

  // Pasted Python (the owner's report): one code block in the pane, tagged
  // with its guessed language, and highlighted once converted.
  await paste('.dropzone', '# Totals for an invented ledger\nimport math\n\ndef total(items):\n    result = 0\n    for item in items:\n        result += item.amount\n    return math.floor(result)\n')
  await waitFor(`!!${EDITOR}`, 'the edit pane')
  const pastedCode = await js(`${EDITOR}.editor.getHTML()`)
  check('pasted Python opens as one Python code block, not a heading', /^<pre><code class="language-python"># Totals/.test(pastedCode) && !pastedCode.includes('<h1'), pastedCode.slice(0, 200))
  // Coloured in the pane too, in the outputs' palette (lib/code-colour.ts).
  await waitFor(`!!document.querySelector('.clip-pane__editor pre .hljs-keyword')`, 'the pasted Python to be coloured')
  const tokenColours = () => js(`(() => {
    const pre = document.querySelector('.clip-pane__editor pre')
    const kw = [...pre.querySelectorAll('.hljs-keyword')].find((s) => s.textContent === 'def')
    return { keyword: kw ? getComputedStyle(kw).color : null, plain: getComputedStyle(pre.querySelector('code') ?? pre).color, spans: pre.querySelectorAll('[class*="hljs-"]').length }
  })()`)
  const colours = await tokenColours()
  check('the pane colours the pasted Python: a keyword is not the colour of plain text', colours.keyword === 'rgb(207, 34, 46)' && colours.plain !== colours.keyword, JSON.stringify(colours))
  // The language picker: Plain text takes the colours off and the class out; back to Python puts both back.
  const pastedHtml = await js(`${EDITOR}.editor.getHTML()`)
  if (process.env.UI_SHOTS) {
    // A JavaScript block beside it, for the picture only; the pane is put back after.
    await typeIntoEditor('<p>And in JavaScript:</p><pre><code class="language-javascript">// Invented totals\nconst rate = 0.2\nfunction total(items) {\n  return items.reduce((sum, item) => sum + item.amount * (1 + rate), 0)\n}\nconsole.log(`total: ${total([])}`)</code></pre>')
  }
  await js(`${EDITOR}.editor.commands.setTextSelection(5)`)
  await waitFor(`!!document.querySelector('select[aria-label="Code language"]')`, 'the language picker')
  await shot('python-and-js')
  // Ctrl+Alt+L from the code reaches the block's picker, as a keyboard user would.
  await js(`(() => { ${EDITOR}.editor.commands.focus(); ${EDITOR}.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })) })()`)
  const focused = await js(`(() => { const s = document.activeElement; return s?.getAttribute('aria-label') === 'Code language' ? { value: s.value, options: s.options.length } : null })()`)
  await shot('picker-focused')
  check('Ctrl+Alt+L in a code block focuses its language picker, which lists the languages', focused?.value === 'python' && focused.options > 40, JSON.stringify(focused))
  const pick = (value) => js(`(() => { const s = document.activeElement?.getAttribute('aria-label') === 'Code language' ? document.activeElement : document.querySelector('select[aria-label="Code language"]'); s.focus(); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await pick('')
  const asPlain = { html: await js(`${EDITOR}.editor.getHTML()`), ...(await tokenColours()) }
  check('choosing Plain text in the picker uncolours the block and drops its class', asPlain.spans === 0 && /^<pre><code># Totals/.test(asPlain.html), JSON.stringify(asPlain).slice(0, 200))
  await pick('python')
  const back = { html: await js(`${EDITOR}.editor.getHTML()`), ...(await tokenColours()) }
  check('choosing Python again colours it and saves class="language-python"', back.spans > 0 && /^<pre><code class="language-python"># Totals/.test(back.html), JSON.stringify(back).slice(0, 200))
  // Real typing (through the DOM, not a command) right beside the picker, at the block's start.
  await js(`${EDITOR}.editor.commands.focus(1)`)
  // Tiptap focuses the view on the next animation frame; until then the page's
  // caret is wherever it was last (by the picker), and typed text goes there.
  await waitFor(`${EDITOR}.editor.view.hasFocus() && getSelection().anchorNode?.nodeType === Node.TEXT_NODE && getSelection().anchorOffset === 0`, 'the caret at the start of the code')
  {
    const id = ++seq
    await new Promise((r) => {
      pending.set(id, r)
      ws.send(JSON.stringify({ id, method: 'Input.insertText', params: { text: 'z' } }))
    })
  }
  await sleep(100)
  const typed = await js(`${EDITOR}.editor.getHTML()`)
  check('typing at the start of a coloured block puts the text in the code, not in the picker', typed.startsWith('<pre><code class="language-python">z# Totals'), typed.slice(0, 120))
  await js(`${EDITOR}.editor.commands.setContent(${JSON.stringify(pastedHtml)})`)
  // Keystroke to paint in a 5,000-line Python block, coloured and plain.
  const typingCost = (language) => js(`(async () => {
    const ed = ${EDITOR}.editor
    const unit = ['def total(items, rate=0.2):', '    """Sum the invented prices."""', '    out = 0', '    for i in items:', '        out += i.price * (1 + rate)  # tax', '    return round(out, 2)', '']
    const code = Array.from({ length: 5000 }, (_, i) => unit[i % unit.length]).join('\\n')
    ed.commands.setContent({ type: 'doc', content: [{ type: 'codeBlock', attrs: { language: ${JSON.stringify(language)} }, content: [{ type: 'text', text: code }] }] })
    await new Promise((r) => setTimeout(r, 600))
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await frame()
    // work: the keystroke's transaction, DOM update and layout, done at once;
    // paint: until the frame after it is drawn, which includes waiting for that frame.
    const work = []
    const paint = []
    for (let k = 0; k < 25; k++) {
      ed.commands.setTextSelection(1500 + k)
      await frame()
      const t0 = performance.now()
      ed.commands.insertContent('x')
      void document.querySelector('.clip-pane__editor pre').getBoundingClientRect()
      work.push(performance.now() - t0)
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
      paint.push(performance.now() - t0)
    }
    const median = (a) => Math.round(a.sort((x, y) => x - y)[a.length >> 1] * 10) / 10
    return { work: median(work), paint: median(paint), spans: document.querySelectorAll('.clip-pane__editor pre [class*="hljs-"]').length }
  })()`)
  // Colouring is judged against the same block uncoloured, measured in
  // turns and keeping each one's best, not against a fixed budget: a busy
  // desktop slows both alike (an absolute 30 ms failed at 54-57 ms that way).
  const best = (a, b) => (b === undefined || a.work < b.work ? a : b)
  let colouredCost
  let plainCost
  for (let round = 0; round < 3; round++) {
    plainCost = best(await typingCost(null), plainCost)
    colouredCost = best(await typingCost('python'), colouredCost)
  }
  console.log(`note  5,000-line Python block, keystroke in ms: coloured ${JSON.stringify(colouredCost)}, plain ${JSON.stringify(plainCost)}`)
  check(
    'typing in a 5,000-line Python block costs little more coloured than plain',
    colouredCost.spans > 0 && colouredCost.work < plainCost.work * 1.5 + 5,
    JSON.stringify({ coloured: colouredCost, plain: plainCost }),
  )
  await js(`${EDITOR}.editor.commands.setContent(${JSON.stringify(pastedHtml)})`)
  await click('HTML')
  await click('Convert to clipboard')
  await waitFor(resultIsUp, 'a result')
  const highlighted = await mainEval(`process.mainModule.require('electron').clipboard.readHTML()`)
  check('converted, the pasted Python is highlighted', highlighted.includes('<code class="language-python hljs">') && highlighted.includes('<span class="hljs-keyword">def</span>'), highlighted.slice(0, 300))
  await dismiss()
  await waitFor(`!!${EDITOR}`, 'the edit pane to come back')
  await startOver()

  // The owner's copy: PyCharm's rich-text flavour, one inline-styled <pre>
  // naming no language, beside the plain text.
  const pyText = 'import math\n\ndef greet(name):\n    if name:\n        print(f"Hello, {name}")\n    return math.pi\n'
  // The shape PyCharm put on the X clipboard: a styled <div> round the <pre>, `<br>` line ends, `&#32;` spaces.
  const pyHtml = '<html><head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body><div style="background-color:#191a1c;color:#bcbec4"><pre style="font-family:\'JetBrains Mono\',monospace;font-size:9.8pt;">' +
    pyText.split('\n').slice(0, -1).map((l) => l.replace(/ /g, '&#32;').replace(/^((?:&#32;)*)(import|def|if|return)&#32;/, '$1<span style="color:#cf8e6d;">$2&#32;</span>') + '<br>').join('') +
    '</pre></div></body></html>'
  await paste('.dropzone', pyText, pyHtml)
  await waitFor(`!!${EDITOR}`, 'the edit pane')
  const fromPyCharm = await js(`${EDITOR}.editor.getHTML()`)
  check('a PyCharm rich-text copy opens as a Python code block', /^<pre><code class="language-python">import math\n\ndef greet/.test(fromPyCharm), fromPyCharm.slice(0, 200))
  await click('HTML')
  await click('Convert to clipboard')
  await waitFor(resultIsUp, 'a result')
  const pyCharmOut = await mainEval(`process.mainModule.require('electron').clipboard.readHTML()`)
  check('converted, the PyCharm copy is highlighted', pyCharmOut.includes('<span class="hljs-keyword">def</span>'), pyCharmOut.slice(0, 300))
  await dismiss()
  await waitFor(`!!${EDITOR}`, 'the edit pane to come back')
  await startOver()

  // Edits in the pane survive a result being shown and dismissed.
  await paste('.dropzone', '# Title\n\nOriginal body.')
  await waitFor(`!!${EDITOR}`, 'the edit pane')
  await click('Markdown')

  // At the size the window opens at, the formatting toolbar is one row.
  const bar = await js(`(() => {
    const t = document.querySelector('.clip-pane__toolbar')
    // Page coordinates: offsetTop is relative to the nearest positioned
    // ancestor, which the Formula and Diagram menus are.
    const ctl = [...t.querySelectorAll('button, select')].map((b) => b.getBoundingClientRect())
    const tops = ctl.map((r) => Math.round(r.top))
    const rows = new Set(tops).size
    const used = Math.max(...ctl.map((r) => r.right)) - Math.min(...ctl.map((r) => r.left))
    const wrap = t.style.flexWrap
    t.style.flexWrap = 'nowrap'
    const needed = t.scrollWidth
    t.style.flexWrap = wrap
    return { rows, controls: tops.length, used, toolbarWidth: t.clientWidth, needed, windowWidth: window.outerWidth, innerWidth: window.innerWidth }
  })()`)
  // The visible one: the hidden render window is a window too.
  const size = await mainEval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find((w) => w.isVisible()).getSize()`)
  console.log(`note  toolbar ${JSON.stringify(bar)}, window ${JSON.stringify(size)}`)
  check('the editor toolbar fits on one row at the default window size', bar.rows === 1, `${bar.rows} rows; the toolbar needs ${bar.needed} px and has ${bar.toolbarWidth}, so the window needs about ${size[0] + bar.needed - bar.toolbarWidth} px wide`)
  await typeIntoEditor('<p>EDITED LINE</p>')
  out = await convert()
  check('a conversion uses the edits in the pane', out.text?.includes('EDITED LINE'), JSON.stringify(out))
  await dismiss()
  await waitFor(`!!${EDITOR}`, 'the edit pane to come back')
  check('edits are still in the pane after Done', (await editorText())?.includes('EDITED LINE'), await editorText())
  out = await convert()
  check('converting again still uses the edits', out.text?.includes('EDITED LINE'), JSON.stringify(out))
  await dismiss()

  // ...including a result that had nothing to do with converting.
  await typeIntoEditor('<p>SECOND EDIT</p>')
  await paste('.app__main', 'http://127.0.0.1:9/nothing-listens-here')
  await waitFor(resultIsUp, 'the failed URL to be reported')
  await dismiss()
  await waitFor(`!!${EDITOR}`, 'the edit pane to come back')
  check('edits survive an unrelated error screen', (await editorText())?.includes('SECOND EDIT'), await editorText())
  await startOver()

  // A file opened in the pane and then changed on disk: edits win, and the
  // app says the disk moved on instead of deciding for the user.
  const doc = join(work, 'doc.md')
  writeAt(doc, 'ALPHA text.\n')
  await dropFile(doc, 'doc.md')
  await click('Edit')
  await waitFor(`!!${EDITOR}`, 'the file to open in the pane')
  await typeIntoEditor('<p>MY EDIT</p>')
  check('no notice while the file is untouched', !/changed on disk/.test(await noticeText()), await noticeText())
  writeAt(doc, 'BETA text.\n')
  await windowRegainsFocus()
  await waitFor(`/changed on disk/.test(document.querySelector('.app__main').textContent)`, 'the changed-on-disk notice')
  check('a notice says the file changed on disk and offers a reload', /doc\.md changed on disk\. Reload\?/.test(await noticeText()), await noticeText())
  out = await convert()
  check('edits win: the conversion uses the pane, not the changed file', out.text?.includes('ALPHA') && out.text?.includes('MY EDIT') && !out.text?.includes('BETA'), JSON.stringify(out))
  await dismiss()
  check('the notice is still there after the conversion', /changed on disk/.test(await noticeText()), await noticeText())

  await click('Reload from disk')
  await waitFor(`${EDITOR}?.textContent.includes('BETA')`, 'the pane to show the file as it is now')
  check('reload replaces the pane with the file on disk', !(await editorText()).includes('MY EDIT'), await editorText())
  check('reload clears the notice', !/changed on disk/.test(await noticeText()), await noticeText())

  await typeIntoEditor('<p>KEEP ME</p>')
  writeAt(doc, 'GAMMA text.\n')
  await windowRegainsFocus()
  await waitFor(`/changed on disk/.test(document.querySelector('.app__main').textContent)`, 'the notice, again')
  await click('Keep my edits')
  await waitFor(`!/changed on disk/.test(document.querySelector('.app__main').textContent)`, 'the notice to go')
  check('keeping the edits leaves the pane alone', (await editorText()).includes('KEEP ME') && !(await editorText()).includes('GAMMA'), await editorText())
  await windowRegainsFocus()
  await sleep(400)
  check('and the notice stays gone until the file changes again', !/changed on disk/.test(await noticeText()), await noticeText())

  // An .svg file (spec D10): a picture, so no Embed/OCR choice and no text
  // targets; the editor shows it as an image; Word gets a PNG copy of it.
  {
    await startOver()
    const plan = join(ROOT, 'tests', 'corpus', 'reading-room-plan.svg')
    await js(
      `(() => { const dt=new DataTransfer(); dt.setData('text/uri-list', ${JSON.stringify(pathToFileURL(plan).href)}); document.querySelector('.dropzone').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true})) })()`,
    )
    await waitFor(`[...document.querySelectorAll('.card__name')].some(e=>e.textContent.includes('reading-room-plan.svg'))`, 'the SVG to load')
    const card = await js(`(() => { const s=[...document.querySelectorAll('.card select')][0]; return { detected: s?.selectedOptions[0]?.textContent, chips: [...document.querySelectorAll('.card .chip')].map(c=>c.textContent.trim()) } })()`)
    check('an .svg is detected as an SVG image, with no Embed/OCR choice', card.detected === 'SVG image' && !card.chips.includes('OCR'), JSON.stringify(card))
    const markdownOff = await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Markdown')?.disabled ?? true`)
    check('an .svg cannot go to Markdown', markdownOff === true, 'Markdown offered')
    await click('Edit')
    await waitFor(`!!document.querySelector('.clip-pane__editor img[src^="data:image/svg+xml;base64,"]')`, 'the SVG in the editor')
    await waitFor(`document.querySelector('.clip-pane__editor img[src^="data:image/svg+xml"]').naturalWidth > 0`, 'the SVG to be drawn')
    const shown = await js(`(() => { const i=document.querySelector('.clip-pane__editor img[src^="data:image/svg+xml"]'); return { w: i.naturalWidth, h: i.naturalHeight, svgInPage: !!document.querySelector('.clip-pane__editor svg') } })()`)
    check('the editor shows the SVG as an image', shown.w === 480 && shown.h === 300 && !shown.svgInPage, JSON.stringify(shown))
    // Converted to the clipboard as HTML, the picture goes as a PNG: Word and Outlook show no pasted SVG.
    await click('HTML')
    await click('Convert to clipboard')
    await waitFor(resultIsUp, 'a result')
    const pasted = await mainEval(`(() => { const { clipboard } = process.mainModule.require('electron'); return clipboard.readHTML() })()`)
    check('converted to the clipboard, the SVG is a PNG picture and no SVG is left', /<img[^>]+src="data:image\/png;base64,/.test(pasted) && !pasted.includes('svg+xml'), pasted.slice(0, 200))
    await dismiss()
    const svgInputs = await js(`window.api.loadUriList(${JSON.stringify(pathToFileURL(plan).href)})`)
    const svgOut = join(work, 'svg-out')
    mkdirSync(svgOut)
    const svgItems = svgInputs.map((i) => ({ base64: '', handle: i.handle, filename: i.filename, source: 'svg' }))
    const svgBatch = await js(`window.api.convertBatch(${JSON.stringify({ items: svgItems, target: 'docx', outDir: svgOut })})`)
    const row = svgBatch.rows[0]
    const docx = row?.status === 'saved' ? readFileSync(row.path).toString('latin1') : ''
    check('it converts to Word with PNG media and no SVG', /word\/media\/[^\0]*?\.png/.test(docx) && !/svg\+xml|media\/[^\0]*?\.svg/.test(docx), JSON.stringify(row))
  }

  // The batch path, straight through the bridge. Naming the output folder
  // skips the folder dialog, which is how "retry" calls it. One file changed
  // after it was added, one deleted: the first converts as it is now, the
  // second costs its own row and nothing else.
  const kept = join(work, 'kept.md')
  const gone = join(work, 'gone.md')
  writeAt(kept, 'batch OLD\n')
  writeAt(gone, 'doomed\n')
  const uris = [kept, gone].map((f) => pathToFileURL(f).href).join('\n')
  const inputs = await js(`window.api.loadUriList(${JSON.stringify(uris)})`)
  check('files loaded from disk carry a handle', inputs.every((i) => typeof i.handle === 'string'), JSON.stringify(inputs).slice(0, 200))
  writeAt(kept, 'batch NEW\n')
  unlinkSync(gone)
  const outDir = join(work, 'out')
  mkdirSync(outDir)
  const items = inputs.map((i) => ({ base64: '', handle: i.handle, filename: i.filename, source: 'md' }))
  const batch = await js(`window.api.convertBatch(${JSON.stringify({ items, target: 'txt', outDir })})`)
  const [first, second] = batch.rows
  check('a batch converts a changed file as it is now', first.status === 'saved' && readFileSync(first.path, 'utf8').includes('batch NEW'), JSON.stringify(first))
  check('a batch reports a deleted file on its own row', second.status === 'error' && /gone\.md/.test(second.message), JSON.stringify(second))

  // The Diagrams choice is for the session only: a fresh start is Sharp (SVG)
  // again, though it was left on PNG above. A reload starts the page afresh, as
  // a restart does; nothing is saved to bring it back.
  await js('location.reload()')
  await sleep(500)
  await waitFor(`!!document.querySelector('.dropzone')`, 'the app to load again')
  await dropFile(join(ROOT, 'tests', 'corpus', 'diagram-notes.md'), 'diagram-notes.md')
  await click('PDF')
  diagramsChoice = await choice('Diagrams and formulas')
  check('after a restart it is Sharp (SVG) again', diagramsChoice?.value === 'svg', JSON.stringify(diagramsChoice))
} catch (err) {
  failures++
  console.log(`FAIL  ${err.message}`)
}

clearTimeout(watchdog)
console.log(failures === 0 ? '\nall UI state checks passed' : `\n${failures} UI state check(s) failed`)
await finish(failures === 0 ? 0 : 1)
