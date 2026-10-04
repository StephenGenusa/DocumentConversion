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

const appArgs = [ROOT, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`]
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

/* --------------------------------- UI helpers --------------------------------- */

const EDITOR = `document.querySelector('.clip-pane__editor .ProseMirror')`
const click = async (label) => {
  const ok = await js(
    `(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if(!b) return false; b.click(); return true })()`,
  )
  if (!ok) throw new Error(`no "${label}" button`)
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
const paste = (selector, text) =>
  js(
    `(() => { const dt=new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)}); document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true})) })()`,
  )

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

  // Edits in the pane survive a result being shown and dismissed.
  await paste('.dropzone', '# Title\n\nOriginal body.')
  await waitFor(`!!${EDITOR}`, 'the edit pane')
  await click('Markdown')
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
} catch (err) {
  failures++
  console.log(`FAIL  ${err.message}`)
}

clearTimeout(watchdog)
console.log(failures === 0 ? '\nall UI state checks passed' : `\n${failures} UI state check(s) failed`)
await finish(failures === 0 ? 0 : 1)
