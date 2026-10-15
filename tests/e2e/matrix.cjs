/* eslint-disable */
/**
 * End-to-end conversion matrix.
 *
 * Runs inside a real Electron main process (so PDF output uses the same hidden
 * BrowserWindow + printToPDF path as the app) and converts every input file in
 * `args.inputs` to every target format, verifying each output by reading it
 * back through the app's own readers.
 *
 * Usage:
 *   npm run build:e2e-core
 *   npx electron tests/e2e/matrix.cjs <outDir> <input1> [input2 ...]
 */
const { app, BrowserWindow } = require('electron')
const { join, basename, extname } = require('path')
const { tmpdir } = require('os')
const { mkdtemp, writeFile, readFile, rm, mkdir } = require('fs/promises')

const core = require('../../out/e2e/core.cjs')
const { createConverter, detect, getReader, TARGET_FORMATS, TABLE_TARGETS, allowedTargets } = core
// The app's SQLite host (sql.js in a worker), built beside core by build:e2e-core.
// Without it the converter refuses databases, as core alone does.
const { createSqliteHost } = require('../../out/e2e/sqlite-host.js')
// The app's render host (spec B5), so diagrams are drawn as they are in the app.
const { createRenderHost } = require('../../out/e2e/render-host.js')
const JSZip = require('jszip')
// An independent KF8 reader, for reading AZW3 output back (pictures included).
// ESM only, whatever its "require" export says, so imported when first used.
const kf8Reader = () => import('@lingo-reader/mobi-parser')

/** Targets that draw a document's Mermaid diagrams (spec B3; Word and Kindle as PNG). */
const DRAWING_TARGETS = ['pdf', 'html', 'revealjs', 'epub', 'azw4', 'docx', 'azw3']

function imageKind(buf) {
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif'
  return 'other'
}

/**
 * Read an AZW3 back: its text through mobi-parser, which resolves every
 * kindle:embed to a file it writes, and record 0's picture fields (first
 * resource, EXTH 125 count, EXTH 201 cover) read directly.
 */
async function readAzw3(out) {
  const dir = await mkdtemp(join(tmpdir(), 'docconv-azw3-'))
  try {
    const file = join(dir, 'book.azw3')
    await writeFile(file, out)
    const { initKf8File } = await kf8Reader()
    const kf8 = await initKf8File(file, dir)
    let html = ''
    const pictures = []
    for (const item of kf8.getSpine()) {
      const ch = kf8.loadChapter(item.id)
      html += ch ? ch.html : ''
      for (const m of (ch ? ch.html : '').matchAll(/<img[^>]+src="([^"]+)"/g)) pictures.push(await readFile(m[1]))
    }
    const count = out.readUInt16BE(76)
    const offsets = Array.from({ length: count }, (_, i) => out.readUInt32BE(78 + i * 8))
    const r0 = out.subarray(offsets[0], offsets[1])
    const exth = new Map()
    let at = 16 + r0.readUInt32BE(20)
    const n = r0.readUInt32BE(at + 8)
    at += 12
    for (let i = 0; i < n; i++) {
      const len = r0.readUInt32BE(at + 4)
      if (len === 12) exth.set(r0.readUInt32BE(at), r0.readUInt32BE(at + 8))
      at += len
    }
    const first = r0.readUInt32BE(16 + 92)
    const record = (i) => out.subarray(offsets[i], i + 1 < count ? offsets[i + 1] : out.length)
    const cover = exth.has(201) ? record(first + exth.get(201)) : undefined
    return { html, pictures, resources: first === 0xffffffff ? 0 : exth.get(125), cover }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Targets the app can also read back; others are verified by shape only. */
function readerFor(format) {
  try {
    return getReader(format)
  } catch {
    return null
  }
}

async function renderHtmlToPdf(html) {
  const dir = await mkdtemp(join(tmpdir(), 'docconv-'))
  const file = join(dir, 'doc.html')
  await writeFile(file, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false, webSecurity: true },
  })
  try {
    await win.loadFile(file)
    return await win.webContents.printToPDF({ printBackground: true })
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await rm(dir, { recursive: true, force: true })
  }
}

// Pick a few distinctive words from the source text to look for in the output.
function probeWords(text) {
  const words = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .split(/[^A-Za-z]+/)
    .filter((w) => w.length >= 6 && w.length <= 14)
  const seen = new Set()
  const out = []
  for (const w of words) {
    const k = w.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(w)
    if (out.length >= 5) break
  }
  return out
}

function sniffOk(target, buf) {
  const head = buf.subarray(0, 8)
  switch (target) {
    case 'pdf':
      return head.toString('latin1', 0, 5) === '%PDF-'
    case 'docx':
      return head[0] === 0x50 && head[1] === 0x4b
    case 'html':
      return buf.toString('utf8', 0, 64).toLowerCase().includes('<!doctype html>')
    default:
      return buf.length > 0
  }
}

async function main() {
  const [outDir, ...inputs] = process.argv.slice(2)
  if (!outDir || inputs.length === 0) {
    console.error('usage: electron matrix.cjs <outDir> <input...>')
    app.exit(2)
    return
  }
  await mkdir(outDir, { recursive: true })
  const renderHost = createRenderHost()
  const conv = createConverter(renderHtmlToPdf, { sqlite: createSqliteHost(), renderBlocks: renderHost.renderBlocks })
  const results = []

  for (const input of inputs) {
    const bytes = await readFile(input)
    const filename = basename(input)
    const det = detect(bytes, filename)
    if (det.kind !== 'ok') {
      results.push({ input: filename, source: '?', target: '*', ok: false, note: `unsupported: ${det.reason}` })
      continue
    }
    const source = det.format
    // Reference text: read the source through its reader, then flatten to text.
    let hubText = ''
    try {
      // Through the converter, not the bare registry: a database needs its engine.
      const hub = source === 'sqlite' ? await conv.read({ bytes, filename }, source) : await getReader(source)({ bytes, filename })
      hubText = hub.html
    } catch (e) {
      results.push({ input: filename, source, target: '*', ok: false, note: `source unreadable: ${e.message}` })
      continue
    }
    const probes = probeWords(hubText)
    const hasTables = hubText.includes('<table')
    const hasDiagrams = hubText.includes('<pre><code class="language-mermaid">')
    // SVG images (an .svg input, or an SVG <img> in a page): Word gets PNG copies (spec D10).
    const hasSvgImages = /src="data:image\/svg\+xml/i.test(hubText)
    // Pictures a Kindle book must keep (decodable raster images; SVG ones get PNG copies).
    const hasRasterImages = /src="data:image\/(?:png|jpe?g|gif|webp)[;,]/i.test(hubText)
    const valid = allowedTargets([{ format: source, imageMode: 'embed' }])

    /**
     * Expected-outcome contract (spec §6.3): each cell is
     * convert | expect-error(<code>) | skip (invalid combination).
     */
    function expectation(target) {
      if (!valid.includes(target)) return { kind: 'skip' }
      // Every table-extraction target errors the same way on a table-less document.
      if (TABLE_TARGETS.includes(target) && !hasTables) return { kind: 'expect-error', code: 'no-tables' }
      return { kind: 'convert' }
    }

    for (const target of TARGET_FORMATS) {
      const expect = expectation(target)
      if (expect.kind === 'skip') {
        results.push({ input: filename, source, target, ok: true, note: 'skip (invalid combination)' })
        console.log(`SKIP  ${source.padEnd(5)} -> ${target.padEnd(4)}  ${filename}`)
        continue
      }
      const t0 = Date.now()
      const rec = { input: filename, source, target, ok: false, ms: 0, bytes: 0, note: '' }
      if (expect.kind === 'expect-error') {
        try {
          await conv.convert({ bytes, filename }, source, target)
          rec.note = `expected error ${expect.code} but conversion succeeded`
        } catch (e) {
          rec.ok = e.code === expect.code
          rec.note = rec.ok ? `expected error ${expect.code}` : `wrong error: ${e.code ?? e.message}`
        }
        rec.ms = Date.now() - t0
        results.push(rec)
        console.log(`${rec.ok ? 'PASS' : 'FAIL'}  ${source.padEnd(5)} -> ${target.padEnd(4)}  ${filename}  ${rec.note}`)
        continue
      }
      try {
        const out = (await conv.convert({ bytes, filename }, source, target)).parts[0].bytes
        rec.ms = Date.now() - t0
        rec.bytes = out.length
        const outName = `${basename(filename, extname(filename))}.${source}-to-${target}.${target}`
        const outPath = join(outDir, outName)
        await writeFile(outPath, out)
        rec.path = outPath
        if (!sniffOk(target, out)) throw new Error('output does not look like ' + target)
        if (hasDiagrams && DRAWING_TARGETS.includes(target)) {
          // A diagram is drawn as SVG where the output takes it (the default),
          // and as PNG for Word: PNG media and no SVG there, an SVG data URI
          // in the HTML-based outputs, an image/svg+xml item (never the
          // cover) in an EPUB.
          if (target === 'docx') {
            const media = Object.keys((await JSZip.loadAsync(out)).files).filter((n) => n.startsWith('word/media/') && !n.endsWith('/'))
            if (!media.some((n) => n.endsWith('.png'))) throw new Error('docx has no PNG media for its diagrams')
            if (media.some((n) => /svg/i.test(n))) throw new Error('docx has SVG media')
            rec.note = `${media.length} media`
          } else if (target === 'html' || target === 'revealjs') {
            if (!out.toString('utf8').includes('src="data:image/svg+xml;base64,')) throw new Error('no drawn SVG diagram in the output')
          } else if (target === 'epub') {
            const zip = await JSZip.loadAsync(out)
            const opf = await zip.file('OEBPS/content.opf').async('string')
            const svgItems = opf.match(/<item [^>]*media-type="image\/svg\+xml"[^>]*>/g) ?? []
            if (svgItems.length === 0) throw new Error('epub has no SVG item for its diagrams')
            if (svgItems.some((i) => i.includes('cover-image'))) throw new Error('a diagram is the epub cover')
            rec.note = `${svgItems.length} SVG items`
          }
        }
        let azw3Html
        if (target === 'azw3') {
          // Pictures survive: every <img> resolves to a JPEG, PNG or GIF
          // record; diagrams and SVG images arrive as PNG; a diagram is never the cover.
          const book = await readAzw3(out)
          if (book.pictures.some((p) => imageKind(p) === 'other')) throw new Error('azw3 has a picture that is not JPEG, PNG or GIF')
          if ((hasDiagrams || hasSvgImages || hasRasterImages) && book.pictures.length === 0) throw new Error('azw3 lost its pictures')
          if ((hasDiagrams || hasSvgImages) && !book.pictures.some((p) => imageKind(p) === 'png')) throw new Error('azw3 has no PNG for its diagrams or SVG images')
          if (/svg/i.test(book.html.replace(/<img[^>]*>/g, ''))) throw new Error('azw3 text still holds SVG')
          if (book.cover && hasDiagrams && !hasSvgImages && !hasRasterImages) throw new Error('a diagram is the azw3 cover')
          rec.note = `${book.pictures.length} pictures, ${book.resources ?? 0} resources${book.cover ? ', cover' : ''}`
          azw3Html = book.html
        }
        if (hasSvgImages && target === 'docx') {
          const zip = await JSZip.loadAsync(out)
          const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !n.endsWith('/'))
          if (!media.some((n) => n.endsWith('.png'))) throw new Error('docx has no PNG media for its SVG images')
          if (media.some((n) => /svg/i.test(n))) throw new Error('docx has SVG media')
          if (/svg/i.test(await zip.file('[Content_Types].xml').async('string'))) throw new Error('docx declares SVG content')
          rec.note = `${media.length} PNG media for SVG images`
        }
        const reader = readerFor(target)
        if (reader || azw3Html !== undefined) {
          // Round-trip: read the output back with the app's reader (an AZW3
          // with mobi-parser, above) and check probe words survive.
          const backHtml = reader ? (await reader({ bytes: out, filename: outName })).html : azw3Html
          const backText = backHtml.replace(/<[^>]+>/g, ' ').toLowerCase()
          // Table extraction keeps only table cells, so document prose is expected to be absent.
          const missing = TABLE_TARGETS.includes(target)
            ? []
            : probes.filter((w) => !backText.includes(w.toLowerCase()))
          rec.probes = probes.length
          rec.missing = missing
          if (probes.length > 0 && missing.length > Math.floor(probes.length / 2)) {
            throw new Error(`content lost: missing ${missing.join(', ')}`)
          }
        } else if (target === 'json') {
          const parsed = JSON.parse(out.toString('utf8'))
          if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('json output is not a non-empty array')
          rec.note = `${parsed.length} rows`
        }
        rec.ok = true
      } catch (e) {
        rec.ms = Date.now() - t0
        rec.note = e.message
      }
      results.push(rec)
      console.log(
        `${rec.ok ? 'PASS' : 'FAIL'}  ${source.padEnd(5)} -> ${target.padEnd(4)}  ${filename}  ` +
          `${rec.bytes}B ${rec.ms}ms${rec.missing && rec.missing.length ? '  missing:' + rec.missing.join(',') : ''}${rec.note ? '  ' + rec.note : ''}`,
      )
    }
  }

  await writeFile(join(outDir, 'results.json'), JSON.stringify(results, null, 2))
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} conversions passed`)
  app.exit(failed.length ? 1 : 0)
}

// The hidden PDF window is the only window; without this Electron quits when it closes.
app.on('window-all-closed', () => {})

app.whenReady().then(() =>
  main().catch((e) => {
    console.error(e)
    app.exit(1)
  }),
)
