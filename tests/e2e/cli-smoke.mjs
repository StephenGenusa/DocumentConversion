/**
 * CLI smoke test (Windows-first — the console contract is fragile there).
 * Prereq: npm run build. Usage: node tests/e2e/cli-smoke.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
// converted: by Automatic by default, as in the app (a photograph to JPG, a
// drawing to PNG); to JPG or PNG when asked.
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
// A drawing: white with a black frame, two colors. Automatic (the default) keeps it PNG.
const lineArt = (() => {
  const w = 64, h = 64, row = w * 3, size = 54 + row * h
  const b = Buffer.alloc(size)
  b.fill(255, 54)
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14)
  b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x === 8 || x === 55 || y === 8 || y === 55) b.fill(0, 54 + y * row + x * 3, 54 + y * row + x * 3 + 3)
  }
  return b
})()
const drawing = join(work, 'drawing.html')
writeFileSync(drawing, `<h1>Drawing</h1><p><img alt="a drawing" src="data:image/bmp;base64,${lineArt.toString('base64')}"></p>`)
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
run('default drawings are PNG', [drawing, '--to', 'epub', '--out', join(work, 'drawing-default.epub')], { expectCode: 0 })
wantPicture('default drawings are PNG', join(work, 'drawing-default.epub'), 'png')
run('--pictures auto', [drawing, '--to', 'epub', '--pictures', 'auto', '--out', join(work, 'drawing-auto.epub')], { expectCode: 0 })
wantPicture('--pictures auto', join(work, 'drawing-auto.epub'), 'png')
run('--pictures jpg for a drawing', [drawing, '--to', 'epub', '--pictures', 'jpg', '--out', join(work, 'drawing-jpg.epub')], { expectCode: 0 })
wantPicture('--pictures jpg for a drawing', join(work, 'drawing-jpg.epub'), 'jpg')
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
  code: { color: false },
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
run('--pictures needs auto, jpg or png', [photo, '--to', 'epub', '--pictures', 'gif'], { expectCode: 2, expectStderr: '--pictures needs auto, jpg or png' })

// Web: --no-fetch leaves web pictures as their description, with a note.
const remote = join(work, 'remote.md')
writeFileSync(remote, '# Remote\n\n![chart](https://example.invalid/chart.png)\n')
// The note names the flag: the command line has no Settings → Web.
run('--no-fetch', [remote, '--to', 'html', '--no-fetch', '--out', join(work, 'remote.html')], {
  expectCode: 0,
  expectFiles: [join(work, 'remote.html')],
  expectStderr: 'NOTE remote.md: 1 web picture was not fetched (--no-fetch).',
  rejectStderr: 'Settings →',
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

// The on flags win over a settings file that turned fetching off, or the
// intranet. Against example.invalid nothing can be fetched, so only the note
// tells: there is none when fetching was on.
const noWeb = settingsFile('no-web-settings.json', { version: 1, web: { fetchPictures: false, allowLocalNetwork: false } })
run('--settings with fetching off', [remote, '--to', 'html', '--settings', noWeb, '--out', join(work, 'remote-off.html')], {
  expectCode: 0,
  expectStderr: 'NOTE remote.md: 1 web picture was not fetched (the settings file turns fetching off; --fetch turns it on).',
  rejectStderr: 'Settings →',
})
run('--fetch wins over --settings', [remote, '--to', 'html', '--settings', noWeb, '--fetch', '--out', join(work, 'remote-on.html')], {
  expectCode: 0,
  expectFiles: [join(work, 'remote-on.html')],
  rejectStderr: 'not fetched',
})
run('--fetch with --no-local-network', [remote, '--to', 'html', '--fetch', '--no-local-network', '--out', join(work, 'remote-on-lan.html')], {
  expectCode: 0,
  rejectStderr: 'not fetched',
})
run('--fetch with --no-fetch exit 2', [remote, '--to', 'html', '--fetch', '--no-fetch'], {
  expectCode: 2,
  expectStderr: '--fetch and --no-fetch are opposites: give one',
})
run('--local-network with --no-local-network exit 2', [remote, '--to', 'html', '--local-network', '--no-local-network'], {
  expectCode: 2,
  expectStderr: '--local-network and --no-local-network are opposites: give one',
})
run('--local-network with --no-fetch exit 2', [remote, '--to', 'html', '--no-fetch', '--local-network'], {
  expectCode: 2,
  expectStderr: '--local-network does nothing with --no-fetch',
})
for (const flag of ['--fetch', '--local-network']) {
  run(`${flag} for mail only exit 2`, [mail, '--to', 'html', flag], {
    expectCode: 2,
    expectStderr: `${flag} does not apply to eml, msg, mbox, ics input`,
  })
}

// A real fetch, from a picture served on this machine's own intranet address
// (the one address an intranet test can count on). Skipped with none.
const intranetIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))?.address
if (!intranetIp) {
  console.log('SKIP  intranet fetches: this machine has no intranet IPv4 address')
} else {
  const dot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const server = spawn(process.execPath, ['-e', `
    const png = Buffer.from(${JSON.stringify(dot)}, 'base64')
    const s = require('node:http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'image/png' }); r.end(png) })
    s.listen(0, ${JSON.stringify(intranetIp)}, () => console.log(s.address().port))
    process.stdin.on('end', () => process.exit(0)).resume()
  `], { stdio: ['pipe', 'pipe', 'inherit'] })
  try {
    const port = await new Promise((resolve, reject) => {
      server.stdout.once('data', (d) => resolve(String(d).trim()))
      server.once('exit', () => reject(new Error('the picture server stopped')))
    })
    // The fetch itself runs without spawnSync blocking the server: it is its own process.
    const lan = join(work, 'lan.md')
    writeFileSync(lan, `# LAN\n\n![dot](http://${intranetIp}:${port}/dot.png)\n`)
    const embedded = (name, file, want) => {
      const got = existsSync(file) && readFileSync(file, 'utf8').includes('data:image/png')
      if (got !== want) {
        failures++
        console.log(`FAIL  ${name}: the intranet picture is ${got ? '' : 'not '}embedded`)
      }
    }
    const runs = [
      ['--settings with fetching off: intranet picture left out', ['--settings', noWeb], false],
      ['--fetch --local-network win over --settings: intranet picture fetched', ['--settings', noWeb, '--fetch', '--local-network'], true],
      ['--fetch alone keeps the file\'s intranet rule', ['--settings', noWeb, '--fetch'], false],
      ['--no-local-network refuses the intranet picture', ['--no-local-network'], false],
      ['default: intranet picture fetched', [], true],
    ]
    for (const [i, [name, flags, want]] of runs.entries()) {
      const out = join(work, `lan-${i}.html`)
      run(name, [lan, '--to', 'html', ...flags, '--out', out], { expectCode: 0, expectFiles: [out] })
      embedded(name, out, want)
    }
  } finally {
    server.stdin.end()
    server.kill()
  }
}

// Code color: on by default, off with --no-code-color, and --code-color wins
// over a settings file that turned it off.
const code = join(work, 'code.md')
writeFileSync(code, '# Code\n\n```js\nconst answer = 42\n```\n')
const plainSettings = settingsFile('plain-code-settings.json', { version: 1, code: { color: false } })
run('code colored by default', [code, '--to', 'html', '--out', join(work, 'code.html')], { expectCode: 0 })
run('--no-code-color', [code, '--to', 'html', '--no-code-color', '--out', join(work, 'code-plain.html')], { expectCode: 0 })
run('--settings with code color off', [code, '--to', 'html', '--settings', plainSettings, '--out', join(work, 'code-file.html')], { expectCode: 0 })
run('--code-color wins over --settings', [code, '--to', 'html', '--settings', plainSettings, '--code-color', '--out', join(work, 'code-flag.html')], {
  expectCode: 0,
})
run('--code-color without --settings', [code, '--to', 'html', '--code-color', '--out', join(work, 'code-on.html')], { expectCode: 0 })
for (const [file, colored] of [['code.html', true], ['code-plain.html', false], ['code-file.html', false], ['code-flag.html', true], ['code-on.html', true]]) {
  if (!existsSync(join(work, file)) || readFileSync(join(work, file), 'utf8').includes('hljs-keyword') !== colored) {
    failures++
    console.log(`FAIL  ${file} is ${colored ? 'not ' : ''}colored`)
  }
}
for (const flag of ['--no-code-color', '--code-color']) {
  run(`${flag} for md exit 2`, [code, '--to', 'md', flag], {
    expectCode: 2,
    expectStderr: `${flag} applies only to pdf, html, revealjs, epub, azw3, azw4, docx output, not md`,
  })
}
run('--code-color with --no-code-color exit 2', [code, '--to', 'html', '--code-color', '--no-code-color'], {
  expectCode: 2,
  expectStderr: '--code-color and --no-code-color are opposites: give one',
})
run('the old --no-code-colour is gone', [code, '--to', 'html', '--no-code-colour'], { expectCode: 2, expectStderr: 'Unknown flag: --no-code-colour' })

// PDF header and footer: --no-header-footer wins over a settings file that
// turned them on. Read back through the PDF reader: the footer says "Page 1 of 1".
const hfSettings = settingsFile('header-footer-settings.json', { version: 1, pdf: { headerFooter: true } })
const footer = (name, pdf, want) => {
  const txt = pdf.replace(/\.pdf$/, '.txt')
  run(`${name} (read back)`, [pdf, '--to', 'txt', '--out', txt], { expectCode: 0, expectFiles: [txt] })
  const got = existsSync(txt) && readFileSync(txt, 'utf8').includes('Page 1 of 1')
  if (got !== want) {
    failures++
    console.log(`FAIL  ${name}: the PDF ${got ? 'has' : 'has no'} footer`)
  }
}
run('--settings with header and footer on', [code, '--to', 'pdf', '--settings', hfSettings, '--out', join(work, 'hf-file.pdf')], { expectCode: 0 })
footer('--settings with header and footer on', join(work, 'hf-file.pdf'), true)
run('--no-header-footer wins over --settings', [code, '--to', 'pdf', '--settings', hfSettings, '--no-header-footer', '--out', join(work, 'hf-off.pdf')], {
  expectCode: 0,
})
footer('--no-header-footer wins over --settings', join(work, 'hf-off.pdf'), false)
run('--header-footer with --no-header-footer exit 2', [code, '--to', 'pdf', '--header-footer', '--no-header-footer'], {
  expectCode: 2,
  expectStderr: '--header-footer and --no-header-footer are opposites: give one',
})
run('--no-header-footer for html exit 2', [code, '--to', 'html', '--no-header-footer'], {
  expectCode: 2,
  expectStderr: '--no-header-footer applies only to pdf output, not html',
})

// OCR language: needs --ocr, an image or PDF, and an installed pack (English ships).
// tests/fixtures/sample.png is a picture of the words "Hello smoke test" (gen-fixtures.mjs).
const sample = join(root, 'tests', 'fixtures', 'sample.png')
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

// Picture files opened on their own: a TIFF of several pages, an EMF (tests/corpus,
// scripts/fixtures/build-picture-files.mjs). Each was read as text before, and came out as garbage.
const lease = join(root, 'tests', 'corpus', 'reading-room-lease.tiff')
run('tiff->pdf: a page a TIFF page', [lease, '--to', 'pdf', '--out', join(work, 'lease.pdf')], { expectCode: 0, expectFiles: [join(work, 'lease.pdf')] })
if (existsSync(join(work, 'lease.pdf'))) {
  const pages = (readFileSync(join(work, 'lease.pdf')).toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length
  if (pages !== 3) {
    failures++
    console.log(`FAIL  lease.pdf has ${pages} pages for a TIFF of 3`)
  }
}
/** Each page's orientation, in order, from its MediaBox: 'L' landscape, 'P' portrait. */
const pageShapes = (file) =>
  [...readFileSync(file).toString('latin1').matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)]
    .map((m) => (Number(m[3]) - Number(m[1]) > Number(m[4]) - Number(m[2]) ? 'L' : 'P'))
    .join('')
// Automatic orientation: the fax's floor plan is a landscape page, and keeps it; Portrait is every page.
if (existsSync(join(work, 'lease.pdf')) && pageShapes(join(work, 'lease.pdf')) !== 'PLP') {
  failures++
  console.log(`FAIL  lease.pdf pages are ${pageShapes(join(work, 'lease.pdf'))}, not PLP (each its own orientation)`)
}
run('tiff->pdf --orientation portrait: every page portrait', [lease, '--to', 'pdf', '--orientation', 'portrait', '--out', join(work, 'lease-portrait.pdf')], {
  expectCode: 0,
  expectFiles: [join(work, 'lease-portrait.pdf')],
})
if (existsSync(join(work, 'lease-portrait.pdf')) && pageShapes(join(work, 'lease-portrait.pdf')) !== 'PPP') {
  failures++
  console.log(`FAIL  lease-portrait.pdf pages are ${pageShapes(join(work, 'lease-portrait.pdf'))}, not PPP`)
}
run('--landscape with --orientation is refused', [lease, '--to', 'pdf', '--landscape', '--orientation', 'auto'], {
  expectCode: 2,
  expectStderr: '--landscape and --orientation both set the orientation',
})
run('--orientation is for pdf only', [lease, '--to', 'docx', '--orientation', 'landscape'], {
  expectCode: 2,
  expectStderr: '--orientation applies only to pdf output, not docx',
})
run('tiff->docx keeps each page a TIFF', [lease, '--to', 'docx', '--out', join(work, 'lease.docx')], { expectCode: 0, expectFiles: [join(work, 'lease.docx')] })
if (existsSync(join(work, 'lease.docx')) && (readFileSync(join(work, 'lease.docx')).toString('latin1').match(/word\/media\/[^\0/]*?\.tif/g) ?? []).length < 3) {
  failures++
  console.log('FAIL  lease.docx does not keep its three TIFF pages')
}
// A picture named as text is read by its bytes, and the command line says so (owner, 2026-10-17).
writeFileSync(join(work, 'lease-scan.txt'), readFileSync(lease))
run('a TIFF named .txt is read as a picture', [join(work, 'lease-scan.txt'), '--to', 'pdf', '--out', join(work, 'lease-scan.pdf')], {
  expectCode: 0,
  expectFiles: [join(work, 'lease-scan.pdf')],
  expectStderr: 'NOTE lease-scan.txt: This file is named .txt but is a TIFF picture; read as a picture.',
})
if (existsSync(join(work, 'lease-scan.pdf')) && pageShapes(join(work, 'lease-scan.pdf')) !== 'PLP') {
  failures++
  console.log(`FAIL  lease-scan.pdf pages are ${pageShapes(join(work, 'lease-scan.pdf'))}, not the fax's PLP`)
}
const plan = join(root, 'tests', 'corpus', 'reading-room-floor-plan.emf')
run('emf->docx keeps the EMF', [plan, '--to', 'docx', '--out', join(work, 'plan.docx')], { expectCode: 0, expectFiles: [join(work, 'plan.docx')] })
if (existsSync(join(work, 'plan.docx')) && !/word\/media\/[^\0/]*?\.emf/.test(readFileSync(join(work, 'plan.docx')).toString('latin1'))) {
  failures++
  console.log('FAIL  plan.docx does not keep the EMF')
}
run('emf->html is drawn as SVG', [plan, '--to', 'html', '--out', join(work, 'plan.html')], { expectCode: 0, expectFiles: [join(work, 'plan.html')] })
if (existsSync(join(work, 'plan.html')) && !/<img[^>]+src="data:image\/svg\+xml;base64,/.test(readFileSync(join(work, 'plan.html'), 'utf8'))) {
  failures++
  console.log('FAIL  plan.html has no SVG drawing')
}
run('emf->txt is refused like any drawing', [plan, '--to', 'txt'], { expectCode: 1, expectStderr: 'cannot convert metafile to txt' })
// OCR, page by page: a fax of two pages, each holding words, read in order.
{
  const { createRequire } = await import('node:module')
  const { createCanvas } = createRequire(join(root, 'package.json'))('@napi-rs/canvas')
  const { tiff } = await import(pathToFileURL(join(root, 'scripts', 'fixtures', 'lib-tiff.mjs')).href)
  const pageOf = (words) => {
    const c = createCanvas(1400, 600)
    const g = c.getContext('2d')
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, 1400, 600)
    g.fillStyle = '#000000'
    g.font = 'bold 72px Arial, "Liberation Sans", "DejaVu Sans", sans-serif'
    g.fillText(words, 100, 300)
    const data = g.getImageData(0, 0, 1400, 600).data
    return { width: 1400, height: 600, pixel: (x, y) => [data[(y * 1400 + x) * 4]], kind: 'bilevel', compression: 'packbits', dpi: 200 }
  }
  const fax = join(work, 'fax.tif')
  writeFileSync(fax, tiff({ pages: [pageOf('DOCUMENT CONVERSION'), pageOf('SEVENTY SEVEN')] }))
  run('--ocr reads every page of a TIFF', [fax, '--to', 'txt', '--ocr', '--out', join(work, 'fax.txt')], { expectCode: 0, expectFiles: [join(work, 'fax.txt')] })
  const text = existsSync(join(work, 'fax.txt')) ? readFileSync(join(work, 'fax.txt'), 'utf8').toLowerCase() : ''
  if (!(text.indexOf('conversion') >= 0 && text.indexOf('seventy') > text.indexOf('conversion'))) {
    failures++
    console.log(`FAIL  fax.txt does not hold both pages' words in order: ${JSON.stringify(text.slice(0, 120))}`)
  }
}

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
