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
const { createConverter, detect, getReader, TARGET_FORMATS, TABLE_TARGETS, allowedTargets, highlightCodeBlocks } = core
const zlib = require('zlib')
// The app's SQLite host (sql.js in a worker), built beside core by build:e2e-core.
// Without it the converter refuses databases, as core alone does.
const { createSqliteHost } = require('../../out/e2e/sqlite-host.js')
// The app's render host (spec B5), so diagrams are drawn as they are in the app.
const { createRenderHost } = require('../../out/e2e/render-host.js')
const JSZip = require('jszip')
// An independent KF8 reader, for reading AZW3 output back (pictures included),
// with kindle:embed read in base 32 (see tests/kf8-reader.mjs). ESM only,
// whatever its "require" export says, so imported when first used.
const kf8Reader = () => import('../kf8-reader.mjs')

/** Targets that draw a document's Mermaid and Graphviz diagrams (spec B3; Word and Kindle as PNG). */
const DRAWING_TARGETS = ['pdf', 'html', 'revealjs', 'epub', 'azw4', 'docx', 'azw3']

function imageKind(buf) {
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif'
  return 'other'
}

/**
 * The SVG parts in a docx's word/media/: by extension or by content. Never by
 * a substring of the name: html-to-docx names each part image-<nanoid>.<ext>,
 * and about 1 name in 1,750 holds "svg" by chance (image-...esvGQu.png).
 */
async function svgMedia(zip, media) {
  const found = []
  for (const n of media) {
    const head = (await zip.file(n).async('nodebuffer')).subarray(0, 256).toString('utf8')
    if (/\.svgz?$/i.test(n) || /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(head)) found.push(n)
  }
  return found
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
/** The PDF inside an AZW4: after the `%MOP` marker, up to its last `%%EOF`. */
function azw4Pdf(bytes) {
  const pdf = bytes.subarray(bytes.indexOf(Buffer.from('%MOP', 'latin1')) + 4)
  return pdf.subarray(0, pdf.lastIndexOf(Buffer.from('%%EOF', 'latin1')) + 5)
}

/** Every DeviceRGB fill (`r g b rg`) drawn by a PDF's Flate content streams. */
function pdfFillColours(pdf) {
  const text = pdf.toString('latin1')
  const fills = []
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length
    const end = text.indexOf('endstream', start)
    if (end === -1) continue
    let body
    try {
      body = zlib.inflateSync(pdf.subarray(start, end)).toString('latin1')
    } catch {
      continue // not a Flate stream (an image, say)
    }
    for (const c of body.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg\b/g)) fills.push([Number(c[1]), Number(c[2]), Number(c[3])])
  }
  return fills
}

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

/**
 * How many pages a TIFF holds: the IFDs in its chain, less previews
 * (NewSubfileType bit 0), read independently of the app's own reader.
 */
function tiffPageCount(buf) {
  const be = buf.toString('latin1', 0, 2) === 'MM'
  const u16 = (at) => (be ? buf.readUInt16BE(at) : buf.readUInt16LE(at))
  const u32 = (at) => (be ? buf.readUInt32BE(at) : buf.readUInt32LE(at))
  let pages = 0
  const seen = new Set()
  for (let at = u32(4); at !== 0 && !seen.has(at) && at + 2 <= buf.length; ) {
    seen.add(at)
    const n = u16(at)
    if (at + 6 + n * 12 > buf.length) break
    let preview = false
    for (let e = at + 2; e < at + 2 + n * 12; e += 12) {
      if (u16(e) === 254) preview = ((u16(e + 2) === 3 ? u16(e + 8) : u32(e + 8)) & 1) === 1
    }
    if (!preview) pages++
    at = u32(at + 2 + n * 12)
  }
  return Math.max(pages, 1)
}

/** The targets whose output is text (or an EPUB of it) a picture's type can be read from. */
const PICTURE_TEXT_TARGETS = ['html', 'revealjs', 'md', 'epub']
/** Every target that shows pictures. */
const PICTURE_TARGETS = ['html', 'revealjs', 'md', 'epub', 'pdf', 'azw3', 'azw4', 'docx']

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
    const hasDiagrams = /<pre><code class="language-(?:mermaid|dot)">/.test(hubText)
    // TeX formulas (step 18): drawn by MathJax, inline ones in the line.
    const hasMath = /<code class="language-math">/.test(hubText)
    // SVG images (an .svg input, or an SVG <img> in a page): Word gets PNG copies (spec D10).
    const hasSvgImages = /src="data:image\/svg\+xml/i.test(hubText)
    // SVG images nested in an SVG image (<image href="data:image/svg+xml…">), which B6 keeps, cleaned.
    const nestedIn = (text) =>
      [...text.matchAll(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g)].filter((m) =>
        /<image\b[^>]*href="data:image\/svg\+xml/.test(Buffer.from(m[1], 'base64').toString('utf8')),
      ).length
    const hasNestedSvgImages = nestedIn(hubText) > 0
    // PNG, JPEG, GIF and WebP pictures placed in an SVG image (<image href="data:image/png…">), which B6 keeps.
    const rastersIn = (text) =>
      [...text.matchAll(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g)].reduce(
        (n, m) => n + (Buffer.from(m[1], 'base64').toString('utf8').match(/<image\b[^>]*href="data:image\/(?:png|jpeg|gif|webp);base64,/g) ?? []).length,
        0,
      )
    const nestedRasters = rastersIn(hubText)
    // Pictures an SVG image names by address (<image href="http…">): with no network here, each becomes its description.
    const addressedIn = (text) =>
      [...text.matchAll(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g)].reduce(
        (n, m) => n + (Buffer.from(m[1], 'base64').toString('utf8').match(/<image\b[^>]*href="(?!data:|#)/g) ?? []).length,
        0,
      )
    const addressedPictures = addressedIn(hubText)
    // Pictures a Kindle book must keep (decodable raster images; SVG ones get PNG copies).
    const hasRasterImages = /src="data:image\/(?:png|jpe?g|gif|webp|tiff)[;,]/i.test(hubText)
    // TIFF pictures, by page (each page of a multi-page TIFF becomes its own picture),
    // which a Kindle book gets as JPEG or PNG (decoded in the render host).
    const tiffImages = [...hubText.matchAll(/src="data:image\/tiff;base64,([A-Za-z0-9+/=]+)"/gi)].reduce(
      (n, m) => n + tiffPageCount(Buffer.from(m[1], 'base64')),
      0,
    )
    // EMF and WMF pictures (Word's vector pictures): kept by Word, drawn for every other target
    // (src/core/metafile): SVG where SVG images stay SVG, PNG for Kindle, the bitmap itself for a
    // metafile that is only one. (Not an alternate, data-alt-src: the picture step chooses between the two.)
    const vectorImages = (hubText.match(/(?<![\w-])src="data:image\/x-[ew]mf[;,]/gi) ?? []).length
    // Code highlight.js finds tokens in (a shell prompt line may hold none).
    const hasColouredCode = /<span class="hljs-/.test(highlightCodeBlocks(hubText).html)
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
      const notices = []
      try {
        const out = (await conv.convert({ bytes, filename }, source, target, undefined, { onAdvice: (_kind, message) => notices.push(message) })).parts[0].bytes
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
            const zip = await JSZip.loadAsync(out)
            const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !n.endsWith('/'))
            if (!media.some((n) => n.endsWith('.png'))) throw new Error('docx has no PNG media for its diagrams')
            if ((await svgMedia(zip, media)).length) throw new Error('docx has SVG media')
            rec.note = `${media.length} media`
          } else if (target === 'html' || target === 'revealjs') {
            const drawn = out.toString('utf8').match(/src="data:image\/svg\+xml;base64,/g) ?? []
            if (drawn.length === 0) throw new Error('no drawn SVG diagram in the output')
            rec.note = `${drawn.length} SVG pictures`
          } else if (target === 'epub') {
            const zip = await JSZip.loadAsync(out)
            const opf = await zip.file('OEBPS/content.opf').async('string')
            const svgItems = opf.match(/<item [^>]*media-type="image\/svg\+xml"[^>]*>/g) ?? []
            if (svgItems.length === 0) throw new Error('epub has no SVG item for its diagrams')
            if (svgItems.some((i) => i.includes('cover-image'))) throw new Error('a diagram is the epub cover')
            rec.note = `${svgItems.length} SVG items`
          }
        }
        if (hasMath && DRAWING_TARGETS.includes(target)) {
          // Formulas: PNG in Word, each inline one lowered onto the baseline
          // (w:position); SVG in the HTML outputs, inline ones lowered with
          // vertical-align; no TeX left as code but a formula that failed.
          if (target === 'docx') {
            const zip = await JSZip.loadAsync(out)
            const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !n.endsWith('/'))
            if (!media.some((n) => n.endsWith('.png'))) throw new Error('docx has no PNG media for its formulas')
            if ((await svgMedia(zip, media)).length) throw new Error('docx has SVG media')
            const doc = await zip.file('word/document.xml').async('string')
            const lowered = (doc.match(/<w:position w:val="-\d+"\/>/g) ?? []).length
            if (/language-math/.test(hubText.replace(/<pre><code class="language-math">/g, '')) && lowered === 0) throw new Error('no inline formula is lowered onto the baseline in Word')
            rec.note = `${rec.note ? rec.note + ', ' : ''}${lowered} lowered formulas`
          } else if (target === 'html' || target === 'revealjs') {
            const text = out.toString('utf8')
            const formulas = text.match(/<img src="data:image\/svg\+xml;base64,[^"]*" alt="[^"]*"[^>]*data-rendered="formula"/g) ?? []
            if (formulas.length === 0) throw new Error('no drawn SVG formula in the output')
            const inline = formulas.filter((f) => /vertical-align:-[0-9.]+ex/.test(f))
            rec.note = `${rec.note ? rec.note + ', ' : ''}${formulas.length} SVG formulas (${inline.length} lowered)`
          }
        }
        if (target === 'azw4' && hasColouredCode) {
          // The embedded PDF, as printed: highlighted code is drawn in colour
          // (a fill that is not grey), and its keywords in a bold monospace
          // face, which is what a reader that reflows the page keeps.
          const pdf = azw4Pdf(out)
          const fills = pdfFillColours(pdf)
          const coloured = fills.filter(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 0.15)
          if (coloured.length === 0) throw new Error('azw4 code is not coloured in its pdf')
          const fonts = [...pdf.toString('latin1').matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/<>\[\]]+)/g)].map((m) => m[1])
          if (!fonts.some((f) => /mono|consolas|courier|menlo/i.test(f) && /bold/i.test(f))) throw new Error('azw4 code keywords are not bold in its pdf')
          rec.note = `${coloured.length} coloured fills`
        }
        if (target === 'revealjs' && hasColouredCode) {
          // Slides colour code as static spans with the screen palette.
          const text = out.toString('utf8')
          if (!/<span class="hljs-/.test(text) || !text.includes('.hljs-keyword')) throw new Error('revealjs code is not coloured')
        }
        let azw3Html
        let azw3Pictures = 0
        if (target === 'azw3') {
          // Pictures survive: every <img> resolves to a JPEG, PNG or GIF
          // record; diagrams and SVG images arrive as PNG; a diagram is never the cover.
          const book = await readAzw3(out)
          if (book.pictures.some((p) => imageKind(p) === 'other')) throw new Error('azw3 has a picture that is not JPEG, PNG or GIF')
          if ((hasDiagrams || hasSvgImages || hasRasterImages || hasMath) && book.pictures.length === 0) throw new Error('azw3 lost its pictures')
          if ((hasDiagrams || hasSvgImages || hasMath) && !book.pictures.some((p) => imageKind(p) === 'png')) throw new Error('azw3 has no PNG for its diagrams, formulas or SVG images')
          if (/svg/i.test(book.html.replace(/<img[^>]*>/g, ''))) throw new Error('azw3 text still holds SVG')
          if (book.pictures.length < tiffImages) throw new Error(`azw3 kept ${book.pictures.length} pictures of ${tiffImages} TIFFs`)
          if (book.cover && (hasDiagrams || hasMath) && !hasSvgImages && !hasRasterImages) throw new Error('a drawn diagram or formula is the azw3 cover')
          rec.note = `${book.pictures.length} pictures, ${book.resources ?? 0} resources${book.cover ? ', cover' : ''}`
          azw3Pictures = book.pictures.length
          azw3Html = book.html
        }
        if ((tiffImages > 0 || vectorImages > 0) && PICTURE_TEXT_TARGETS.includes(target)) {
          // Every target gets pictures it can show (pictures.ts): no TIFF, EMF or
          // WMF in a web page, slides, Markdown or EPUB; a PNG or JPEG for each TIFF.
          let text = out.toString('utf8')
          let items = 0
          if (target === 'epub') {
            const zip = await JSZip.loadAsync(out)
            const names = Object.keys(zip.files)
            text = (await Promise.all(names.filter((n) => /\.(xhtml|opf|html)$/.test(n)).map((n) => zip.file(n).async('string')))).join('\n')
            if (names.some((n) => /\.(tiff?|emf|wmf)$/i.test(n))) throw new Error('epub holds a TIFF, EMF or WMF file')
            items = (text.match(/media-type="image\/(?:png|jpeg)"/g) ?? []).length
          }
          if (/image\/(?:tiff|x-emf|x-wmf)/i.test(text)) throw new Error(`${target} still holds a TIFF, EMF or WMF picture`)
          const shown = (text.match(/data:image\/(?:png|jpeg);base64,/g) ?? []).length + items
          if (shown < tiffImages) throw new Error(`${target} has ${shown} PNG or JPEG pictures for ${tiffImages} TIFFs`)
          const vectorsShown = shown + (text.match(/data:image\/svg\+xml;base64,/g) ?? []).length + (target === 'epub' ? (text.match(/media-type="image\/svg\+xml"/g) ?? []).length : 0)
          if (vectorsShown < tiffImages + vectorImages) throw new Error(`${target} shows ${vectorsShown} pictures for ${tiffImages} TIFF pages and ${vectorImages} EMF/WMF`)
          rec.note = `${rec.note ? rec.note + ', ' : ''}no TIFF, EMF or WMF left (${tiffImages} TIFF pages, ${vectorImages} EMF/WMF in)`
        }
        if (vectorImages > 0 && target !== 'docx' && PICTURE_TARGETS.includes(target)) {
          // Every EMF and WMF is drawn: none left as its alt text (each would come with a notice).
          const lost = notices.filter((m) => /\b(EMF|WMF)\b/.test(m))
          if (lost.length) throw new Error(`${target} lost ${lost.length} EMF/WMF pictures: ${lost[0]}`)
          if (target === 'azw3' && azw3Pictures < vectorImages) throw new Error(`azw3 kept ${azw3Pictures} pictures for ${vectorImages} EMF/WMF`)
          rec.note = `${rec.note ? rec.note + ', ' : ''}${vectorImages} EMF/WMF drawn`
        }
        if (tiffImages > 0 && (target === 'pdf' || target === 'azw4')) {
          // Printed by Chromium, which shows no TIFF: each is an image in the PDF.
          const images = (out.toString('latin1').match(/\/Subtype\s*\/Image\b/g) ?? []).length
          if (images < tiffImages) throw new Error(`${target} has ${images} images for ${tiffImages} TIFFs`)
          rec.note = `${rec.note ? rec.note + ', ' : ''}${images} images for ${tiffImages} TIFFs`
        }
        if ((tiffImages > 0 || vectorImages > 0) && target === 'docx') {
          // Word keeps TIFF (one a page), EMF and WMF as they are, each part's type declared.
          const zip = await JSZip.loadAsync(out)
          const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !n.endsWith('/'))
          const tifs = media.filter((n) => /\.tif$/.test(n)).length
          const vectors = media.filter((n) => /\.(emf|wmf)$/.test(n)).length
          if (tifs < tiffImages) throw new Error(`docx kept ${tifs} TIFF pictures of ${tiffImages} TIFF pages`)
          if (vectors < vectorImages) throw new Error(`docx kept ${vectors} EMF/WMF pictures of ${vectorImages}`)
          const types = await zip.file('[Content_Types].xml').async('string')
          for (const ext of new Set(media.map((n) => n.replace(/^.*\./, '')))) {
            if (!types.includes(`Extension="${ext}"`)) throw new Error(`docx declares no content type for .${ext}`)
          }
          rec.note = `${rec.note ? rec.note + ', ' : ''}${tifs} TIFF, ${vectors} EMF/WMF kept`
        }
        if (hasSvgImages && target === 'docx') {
          const zip = await JSZip.loadAsync(out)
          const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/') && !n.endsWith('/'))
          if (!media.some((n) => n.endsWith('.png'))) throw new Error('docx has no PNG media for its SVG images')
          if ((await svgMedia(zip, media)).length) throw new Error('docx has SVG media')
          if (/image\/svg\+xml|Extension="svgz?"/i.test(await zip.file('[Content_Types].xml').async('string'))) throw new Error('docx declares SVG content')
          // Every distinct SVG image gets its own PNG (Word once stopped at 100).
          const distinct = new Set([...hubText.matchAll(/src="(data:image\/svg\+xml[^"]*)"/g)].map((m) => m[1])).size
          if (distinct > 100 && media.filter((n) => n.endsWith('.png')).length < distinct) throw new Error(`docx has fewer PNG media than its ${distinct} SVG images`)
          rec.note = `${media.length} PNG media for SVG images`
        }
        if (hasNestedSvgImages && (target === 'html' || target === 'epub')) {
          let found = 0
          if (target === 'html') found = nestedIn(out.toString('utf8'))
          else {
            const zip = await JSZip.loadAsync(out)
            for (const n of Object.keys(zip.files).filter((n) => n.endsWith('.svg'))) {
              if (/<image\b[^>]*href="data:image\/svg\+xml/.test(await zip.file(n).async('string'))) found++
            }
          }
          if (found === 0) throw new Error(`${target} lost the SVG images nested in an SVG image`)
          rec.note = `${rec.note ? rec.note + ', ' : ''}nested SVG images kept`
        }
        if (nestedRasters > 0 && (target === 'html' || target === 'epub')) {
          let found = 0
          if (target === 'html') found = rastersIn(out.toString('utf8'))
          else {
            const zip = await JSZip.loadAsync(out)
            for (const n of Object.keys(zip.files).filter((n) => n.endsWith('.svg'))) {
              found += ((await zip.file(n).async('string')).match(/<image\b[^>]*href="data:image\/(?:png|jpeg|gif|webp);base64,/g) ?? []).length
            }
          }
          if (found < nestedRasters) throw new Error(`${target} kept ${found} of the ${nestedRasters} pictures placed in an SVG image`)
          rec.note = `${rec.note ? rec.note + ', ' : ''}${found} pictures in SVG kept`
        }
        if (addressedPictures > 0 && target === 'html') {
          const html = out.toString('utf8')
          if (addressedIn(html) > 0) throw new Error('html still has an SVG picture named by address')
          const described = [...html.matchAll(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g)].filter((m) =>
            Buffer.from(m[1], 'base64').toString('utf8').includes('>[image: '),
          ).length
          if (described === 0) throw new Error('html lost the description of an SVG picture it could not fetch')
          rec.note = `${rec.note ? rec.note + ', ' : ''}SVG picture by address described`
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
