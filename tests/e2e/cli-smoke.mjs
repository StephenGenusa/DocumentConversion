/**
 * CLI smoke test (Windows-first — the console contract is fragile there).
 * Prereq: npm run build. Usage: node tests/e2e/cli-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The electron package exports the path to its own binary, which is
// `electron.exe` on Windows and `electron` everywhere else. This was hardcoded
// to the Windows name, so the whole smoke suite failed on Linux before running
// a single case - and failed obscurely, because spawnSync on a missing binary
// leaves res.stderr undefined and the reporter crashed trying to slice it.
const { default: electron } = await import('electron')
const appEntry = join(root, 'out', 'main', 'index.js')
const work = mkdtempSync(join(tmpdir(), 'docconv-cli-'))
// Every run gets its own profile (Chromium's --user-data-dir), so nothing here
// reads or writes the real userData - the app's settings file above all.
const profile = join(work, 'profile')

let failures = 0
function run(name, args, { expectCode, expectFiles = [], expectStderr, rejectStderr }) {
  const res = spawnSync(electron, [appEntry, 'convert', ...args, `--user-data-dir=${profile}`], { encoding: 'utf8', timeout: 120000 })
  const problems = []
  if (res.error) problems.push(`could not run: ${res.error.message}`)
  if (res.status !== expectCode) problems.push(`exit ${res.status}, wanted ${expectCode}`)
  for (const f of expectFiles) if (!existsSync(f)) problems.push(`missing output ${f}`)
  if (expectStderr && !res.stderr.includes(expectStderr)) problems.push(`stderr missing "${expectStderr}"`)
  if (rejectStderr && res.stderr.includes(rejectStderr)) problems.push(`stderr has "${rejectStderr}"`)
  if (problems.length) {
    failures++
    console.log(`FAIL  ${name}: ${problems.join('; ')}\n  stderr: ${(res.stderr ?? '').slice(0, 300)}`)
  } else {
    console.log(`PASS  ${name}`)
  }
}

// fixtures
const md = join(work, 'spec.md')
writeFileSync(md, '# CLI Smoke\n\nHello from the **command line**.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n')
const md2 = join(work, 'notes.md')
writeFileSync(md2, '# Second\n\nAnother document body here.\n')

// 1. single convert, default out path (alongside input)
run('single md->html default out', [md, '--to', 'html'], {
  expectCode: 0,
  expectFiles: [join(work, 'spec.html')],
})

// 2. single convert to pdf with options
run('single md->pdf with flags', [md, '--to', 'pdf', '--out', join(work, 'spec.pdf'), '--scale', '1.25', '--page', 'A4', '--header-footer'], {
  expectCode: 0,
  expectFiles: [join(work, 'spec.pdf')],
})

// 3. batch to directory
const outDir = join(work, 'batch')
run('batch to dir', [md, md2, '--to', 'txt', '--out', outDir], {
  expectCode: 0,
  expectFiles: [join(outDir, 'spec.txt'), join(outDir, 'notes.txt')],
})

// 4. merge
run('merge to one docx', [md, md2, '--to', 'docx', '--merge', '--out', join(work, 'merged.docx')], {
  expectCode: 0,
  expectFiles: [join(work, 'merged.docx')],
})

// 5. csv extraction
run('md->csv table extraction', [md, '--to', 'csv', '--out', join(work, 'table.csv')], {
  expectCode: 0,
  expectFiles: [join(work, 'table.csv')],
})

// 6. --no-clobber refuses second write
run('no-clobber', [md, '--to', 'html', '--out', join(work, 'spec.html'), '--no-clobber'], {
  expectCode: 1,
  expectStderr: 'refusing to overwrite',
})

// 7. bad usage
run('bad usage exit 2', [md], { expectCode: 2, expectStderr: '--to is required' })

// 8. missing input
run('missing input exit 1', [join(work, 'nope.md'), '--to', 'html'], { expectCode: 1, expectStderr: 'ERROR' })

// 9. SQLite, through the real worker host: printed, and exported every row.
// The database is made with sql.js (a devDependency) here.
const { createRequire } = await import('node:module')
const initSqlJs = createRequire(import.meta.url)('sql.js')
const SQL = await initSqlJs()
const sqlDb = new SQL.Database()
sqlDb.run(`CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT);
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
  INSERT INTO products SELECT i, 'product ' || i FROM n;
  CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES ('Smoke note');
  CREATE VIEW recent AS SELECT name FROM products WHERE id > 5990;`)
const shop = join(work, 'shop.sqlite')
writeFileSync(shop, Buffer.from(sqlDb.export()))
sqlDb.close()
run('sqlite->pdf', [shop, '--to', 'pdf', '--out', join(work, 'shop.pdf')], { expectCode: 0, expectFiles: [join(work, 'shop.pdf')] })
run('sqlite->csv with views', [shop, '--to', 'csv', '--sqlite-views', '--out', join(work, 'shop.csv')], {
  expectCode: 0,
  expectFiles: [join(work, 'shop.notes.csv'), join(work, 'shop.products.csv'), join(work, 'shop.recent.csv')],
})
run('sqlite->xlsx', [shop, '--to', 'xlsx', '--out', join(work, 'shop.xlsx')], { expectCode: 0, expectFiles: [join(work, 'shop.xlsx')] })
run('--sqlite-views with no database exit 2', [md, '--to', 'csv', '--sqlite-views'], {
  expectCode: 2,
  expectStderr: '--sqlite-views applies only to sqlite input',
})
if (existsSync(join(work, 'shop.products.csv'))) {
  const lines = readFileSync(join(work, 'shop.products.csv'), 'utf8').trim().split(/\r?\n/)
  const recent = existsSync(join(work, 'shop.recent.csv')) ? readFileSync(join(work, 'shop.recent.csv'), 'utf8').trim().split(/\r?\n/) : []
  if (lines.length !== 6001 || recent.length !== 11) {
    failures++
    console.log(`FAIL  sqlite csv: ${lines.length - 1} product rows (want 6000), ${recent.length - 1} view rows (want 10)`)
  }
}
if (existsSync(join(work, 'shop.pdf')) && readFileSync(join(work, 'shop.pdf')).subarray(0, 5).toString('latin1') !== '%PDF-') {
  failures++
  console.log('FAIL  shop.pdf is not a PDF')
}

// Diagrams (spec B3, B7): drawn as PNG in Word output; a broken one stays as
// source with a NOTE on stderr, and the conversion still succeeds.
const diagrams = join(work, 'diagrams.md')
writeFileSync(diagrams, '# Diagrams\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nflowchart LR\n  A -->\n```\n')
run('mermaid->docx draws, notes the broken one', [diagrams, '--to', 'docx', '--out', join(work, 'diagrams.docx')], {
  expectCode: 0,
  expectFiles: [join(work, 'diagrams.docx')],
  expectStderr: 'NOTE diagrams.md: Diagram 2 could not be drawn: Parse error: the diagram ends too soon',
})
if (existsSync(join(work, 'diagrams.docx'))) {
  const names = readFileSync(join(work, 'diagrams.docx')).toString('latin1')
  if (!/word\/media\/[^\0]*?\.png/.test(names)) {
    failures++
    console.log('FAIL  diagrams.docx has no PNG media')
  }
}

// Diagrams as SVG by default where the output takes it; --diagrams png asks for images.
run('mermaid->html embeds SVG by default', [diagrams, '--to', 'html', '--out', join(work, 'diagrams-svg.html')], {
  expectCode: 0,
  expectFiles: [join(work, 'diagrams-svg.html')],
})
run('mermaid->html --diagrams png', [diagrams, '--to', 'html', '--diagrams', 'png', '--out', join(work, 'diagrams-png.html')], {
  expectCode: 0,
  expectFiles: [join(work, 'diagrams-png.html')],
})
for (const [file, mime] of [['diagrams-svg.html', 'image/svg+xml'], ['diagrams-png.html', 'image/png']]) {
  if (existsSync(join(work, file)) && !readFileSync(join(work, file), 'utf8').includes(`src="data:${mime};base64,`)) {
    failures++
    console.log(`FAIL  ${file} has no ${mime} diagram`)
  }
}
// Formulas (step 18): drawn by MathJax; an unknown macro stays source with a NOTE.
const formulas = join(work, 'formulas.md')
writeFileSync(formulas, '# Formulas\n\nLet $x_i^2$ hold and $\\nosuch{y}$ too.\n\n$$\\sum_{i=1}^n x_i$$\n')
run('math->html draws, notes the unknown macro', [formulas, '--to', 'html', '--out', join(work, 'formulas.html')], {
  expectCode: 0,
  expectFiles: [join(work, 'formulas.html')],
  expectStderr: 'NOTE formulas.md: Formula 2 could not be drawn: Undefined control sequence \\nosuch',
})
if (existsSync(join(work, 'formulas.html'))) {
  const html = readFileSync(join(work, 'formulas.html'), 'utf8')
  if ((html.match(/data-rendered="formula"/g) ?? []).length !== 2 || !/vertical-align:-[0-9.]+ex/.test(html)) {
    failures++
    console.log('FAIL  formulas.html does not hold two drawn formulas, the inline one lowered')
  }
}

// Word equations (step 19): recovered as TeX, so Markdown gets $…$ and $$…$$;
// the fixture's one unknown element is a NOTE.
const equations = join(root, 'tests', 'corpus', 'treasurer-equations.docx')
run('docx equations->md as TeX', [equations, '--to', 'md', '--out', join(work, 'equations.md')], {
  expectCode: 0,
  expectFiles: [join(work, 'equations.md')],
  expectStderr: 'NOTE treasurer-equations.docx: One equation has a part that could not be read as a formula',
})
if (existsSync(join(work, 'equations.md'))) {
  const md = readFileSync(join(work, 'equations.md'), 'utf8')
  if (!md.includes('a share $\\frac{a}{b}$ of the stock') || !md.includes('$$\\sqrt{a^{2}+b^{2}},\\quad\\sqrt[3]{V}$$')) {
    failures++
    console.log('FAIL  equations.md does not hold the inline and display formulas')
  }
}

run('--diagrams for Word exit 2', [diagrams, '--to', 'docx', '--diagrams', 'svg'], {
  expectCode: 2,
  expectStderr: '--diagrams applies only to pdf, html, revealjs, epub, azw4 output, not docx',
})

// An .svg file (spec D10): read as a picture, and given to Word as a PNG, never as SVG media.
const svgIn = join(work, 'plan.svg')
writeFileSync(svgIn, '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#2f5d8a"/></svg>\n')
run('svg->docx has PNG media', [svgIn, '--to', 'docx', '--out', join(work, 'plan.docx')], {
  expectCode: 0,
  expectFiles: [join(work, 'plan.docx')],
})
if (existsSync(join(work, 'plan.docx'))) {
  const names = readFileSync(join(work, 'plan.docx')).toString('latin1')
  if (!/word\/media\/[^\0]*?\.png/.test(names) || /svg\+xml|\.svg/.test(names)) {
    failures++
    console.log('FAIL  plan.docx has no PNG media, or has SVG media')
  }
}

// And to Kindle as a PNG picture record the text points at (kindle:embed).
run('svg->azw3 has a PNG picture', [svgIn, '--to', 'azw3', '--out', join(work, 'plan.azw3')], {
  expectCode: 0,
  expectFiles: [join(work, 'plan.azw3')],
})
if (existsSync(join(work, 'plan.azw3'))) {
  const book = readFileSync(join(work, 'plan.azw3'))
  if (!book.includes(Buffer.from('kindle:embed:0001?mime=image/png')) || !book.includes(Buffer.from('\x89PNG', 'latin1')) || book.includes(Buffer.from('svg+xml'))) {
    failures++
    console.log('FAIL  plan.azw3 has no PNG picture, or still holds SVG')
  }
}

// Settings (settings spec 5.7). A picture an EPUB can't hold (BMP) is
// converted: to JPG by default, as in the app; PNG when asked.
const bmp = (() => {
  const w = 4, h = 4, row = w * 3, size = 54 + row * h
  const b = Buffer.alloc(size)
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14)
  b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34)
  for (let i = 54; i < size; i += 3) { b[i] = 200; b[i + 1] = i & 255; b[i + 2] = (i * 7) & 255 }
  return b
})()
const photo = join(work, 'photo.html')
writeFileSync(photo, `<h1>Photo</h1><p><img alt="a photo" src="data:image/bmp;base64,${bmp.toString('base64')}"></p>`)
/** The converted picture's file name inside an EPUB, from the zip's (uncompressed) directory. */
const epubPicture = (file) => (existsSync(file) ? /OEBPS\/images\/img001\.(jpg|png)/.exec(readFileSync(file).toString('latin1'))?.[1] : undefined)
function wantPicture(name, file, ext) {
  const got = epubPicture(file)
  if (got !== ext) {
    failures++
    console.log(`FAIL  ${name}: picture is ${got ?? 'missing'}, wanted ${ext}`)
  }
}
const settingsFile = (name, json) => {
  const path = join(work, name)
  writeFileSync(path, JSON.stringify(json))
  return path
}
const pngSettings = settingsFile('png-settings.json', { version: 1, pictures: { format: 'png' } })

run('default pictures are JPG', [photo, '--to', 'epub', '--out', join(work, 'photo-default.epub')], { expectCode: 0 })
wantPicture('default pictures are JPG', join(work, 'photo-default.epub'), 'jpg')
run('--pictures png', [photo, '--to', 'epub', '--pictures', 'png', '--out', join(work, 'photo-png.epub')], { expectCode: 0 })
wantPicture('--pictures png', join(work, 'photo-png.epub'), 'png')
run('--settings file applies', [photo, '--to', 'epub', '--settings', pngSettings, '--out', join(work, 'photo-file.epub')], { expectCode: 0 })
wantPicture('--settings file applies', join(work, 'photo-file.epub'), 'png')
run('a flag wins over --settings', [photo, '--to', 'epub', '--settings', pngSettings, '--pictures', 'jpg', '--out', join(work, 'photo-flag.epub')], { expectCode: 0 })
wantPicture('a flag wins over --settings', join(work, 'photo-flag.epub'), 'jpg')

// --settings app: the file the window saves in userData, here this run's profile.
run('--settings app with no saved settings', [photo, '--to', 'epub', '--settings', 'app', '--out', join(work, 'photo-noapp.epub')], {
  expectCode: 0,
  expectStderr: 'NOTE settings: the app has no saved settings yet',
})
mkdirSync(profile, { recursive: true })
const appSettings = join(profile, 'settings.json')
writeFileSync(appSettings, JSON.stringify({ version: 1, pictures: { format: 'png' } }))
run('--settings app reads the app\'s file', [photo, '--to', 'epub', '--settings', 'app', '--out', join(work, 'photo-app.epub')], { expectCode: 0 })
wantPicture('--settings app reads the app\'s file', join(work, 'photo-app.epub'), 'png')
run('without --settings the app\'s file is not read', [photo, '--to', 'epub', '--out', join(work, 'photo-noread.epub')], { expectCode: 0 })
wantPicture('without --settings the app\'s file is not read', join(work, 'photo-noread.epub'), 'jpg')
// A bad file is read only: never renamed aside, never rewritten.
writeFileSync(appSettings, '{ not json')
run('--settings app, not JSON, exit 2', [photo, '--to', 'epub', '--settings', 'app'], { expectCode: 2, expectStderr: 'is not valid JSON' })
if (readFileSync(appSettings, 'utf8') !== '{ not json' || readdirSync(profile).some((n) => n.startsWith('settings.json.'))) {
  failures++
  console.log('FAIL  --settings app changed or renamed the app\'s file')
}
rmSync(appSettings)
run('--settings missing file exit 2', [photo, '--to', 'epub', '--settings', join(work, 'nope.json')], {
  expectCode: 2,
  expectStderr: 'The settings file could not be read',
})
// A file value that can't apply is ignored; a bad one is a note, never a usage error.
const otherSettings = settingsFile('other-settings.json', {
  version: 1,
  pictures: { format: 'png' },
  pdf: { pageSize: 'A4' },
  code: { colour: false },
  ocr: { language: 'deu' },
  rendered: { format: 'gif' },
})
run('--settings values that cannot apply are ignored', [md, '--to', 'txt', '--settings', otherSettings, '--out', join(work, 'other.txt')], {
  expectCode: 0,
  expectFiles: [join(work, 'other.txt')],
  expectStderr: 'NOTE settings: rendered.format: "gif" is not one of svg, png; the default is used.',
  rejectStderr: 'OCR language',
})
run('--pictures for txt exit 2', [photo, '--to', 'txt', '--pictures', 'png'], {
  expectCode: 2,
  expectStderr: '--pictures applies only to html, revealjs, pdf, azw4, epub, azw3, md, docx output, not txt',
})
run('--pictures needs jpg or png', [photo, '--to', 'epub', '--pictures', 'gif'], { expectCode: 2, expectStderr: '--pictures needs jpg or png' })

// Web: --no-fetch leaves web pictures as their description, with a note.
const remote = join(work, 'remote.md')
writeFileSync(remote, '# Remote\n\n![chart](https://example.invalid/chart.png)\n')
run('--no-fetch', [remote, '--to', 'html', '--no-fetch', '--out', join(work, 'remote.html')], {
  expectCode: 0,
  expectFiles: [join(work, 'remote.html')],
  expectStderr: 'NOTE remote.md: 1 web picture was not fetched',
})
if (existsSync(join(work, 'remote.html')) && !readFileSync(join(work, 'remote.html'), 'utf8').includes('[image: chart]')) {
  failures++
  console.log('FAIL  remote.html does not describe the unfetched picture')
}
run('--no-local-network', [remote, '--to', 'html', '--no-local-network', '--out', join(work, 'remote-lan.html')], {
  expectCode: 0,
  expectFiles: [join(work, 'remote-lan.html')],
  rejectStderr: 'not fetched',
})
run('--no-local-network with --no-fetch exit 2', [remote, '--to', 'html', '--no-fetch', '--no-local-network'], {
  expectCode: 2,
  expectStderr: '--no-local-network does nothing with --no-fetch',
})
const mail = join(work, 'mail.eml')
writeFileSync(mail, 'From: a@example.com\r\nTo: b@example.com\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nHello\r\n')
run('--no-fetch for mail only exit 2', [mail, '--to', 'html', '--no-fetch'], {
  expectCode: 2,
  expectStderr: '--no-fetch does not apply to eml, msg, mbox, ics input',
})

// Code colour: on by default, off with --no-code-colour.
const code = join(work, 'code.md')
writeFileSync(code, '# Code\n\n```js\nconst answer = 42\n```\n')
run('code coloured by default', [code, '--to', 'html', '--out', join(work, 'code.html')], { expectCode: 0 })
run('--no-code-colour', [code, '--to', 'html', '--no-code-colour', '--out', join(work, 'code-plain.html')], { expectCode: 0 })
for (const [file, coloured] of [['code.html', true], ['code-plain.html', false]]) {
  if (existsSync(join(work, file)) && readFileSync(join(work, file), 'utf8').includes('hljs-keyword') !== coloured) {
    failures++
    console.log(`FAIL  ${file} is ${coloured ? 'not ' : ''}coloured`)
  }
}
run('--no-code-colour for md exit 2', [code, '--to', 'md', '--no-code-colour'], {
  expectCode: 2,
  expectStderr: '--no-code-colour applies only to pdf, html, revealjs, epub, azw3, azw4, docx output, not md',
})

// OCR language: needs --ocr, an image or PDF, and an installed pack (English ships).
// tests/fixtures/sample.png fails libpng's CRC check, so a picture of words is drawn here.
const { createCanvas } = createRequire(import.meta.url)('@napi-rs/canvas')
const canvas = createCanvas(600, 120)
const pen = canvas.getContext('2d')
pen.fillStyle = '#fff'
pen.fillRect(0, 0, 600, 120)
pen.fillStyle = '#000'
pen.font = '56px sans-serif'
pen.fillText('Hello smoke test', 20, 80)
const sample = join(work, 'words.png')
writeFileSync(sample, canvas.toBuffer('image/png'))
run('--ocr --ocr-lang eng', [sample, '--to', 'txt', '--ocr', '--ocr-lang', 'eng', '--out', join(work, 'sample.txt')], {
  expectCode: 0,
  expectFiles: [join(work, 'sample.txt')],
})
if (existsSync(join(work, 'sample.txt')) && !readFileSync(join(work, 'sample.txt'), 'utf8').includes('Hello smoke test')) {
  failures++
  console.log('FAIL  sample.txt does not hold the words in the picture')
}
run('--ocr-lang without --ocr exit 2', [sample, '--to', 'txt', '--ocr-lang', 'eng'], { expectCode: 2, expectStderr: '--ocr-lang needs --ocr' })
run('--ocr-lang not installed exit 2', [sample, '--to', 'txt', '--ocr', '--ocr-lang', 'deu'], {
  expectCode: 2,
  expectStderr: '--ocr-lang: deu is not installed',
})
run('--ocr-lang unknown exit 2', [sample, '--to', 'txt', '--ocr', '--ocr-lang', 'klingon'], {
  expectCode: 2,
  expectStderr: '--ocr-lang: klingon is not an OCR language',
})
run('--ocr-lang with no image or PDF exit 2', [md, '--to', 'txt', '--ocr', '--ocr-lang', 'eng'], {
  expectCode: 2,
  expectStderr: '--ocr-lang applies only to image, pdf input',
})
const deuSettings = settingsFile('deu-settings.json', { version: 1, ocr: { language: 'deu' } })
run('--settings OCR language not installed: English, with a note', [sample, '--to', 'txt', '--ocr', '--settings', deuSettings, '--out', join(work, 'sample-deu.txt')], {
  expectCode: 0,
  expectFiles: [join(work, 'sample-deu.txt')],
  expectStderr: "NOTE settings: The settings file's OCR language (deu) is not installed; English is used.",
})

// content sanity
if (existsSync(join(work, 'spec.html'))) {
  const html = readFileSync(join(work, 'spec.html'), 'utf8')
  if (!html.includes('command line')) {
    failures++
    console.log('FAIL  spec.html content missing body text')
  }
}
if (existsSync(join(work, 'spec.pdf'))) {
  const head = readFileSync(join(work, 'spec.pdf')).subarray(0, 5).toString('latin1')
  if (head !== '%PDF-') {
    failures++
    console.log('FAIL  spec.pdf is not a PDF')
  }
}

console.log(failures ? `\n${failures} smoke check(s) failed` : '\nCLI smoke: all checks passed')
rmSync(work, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
