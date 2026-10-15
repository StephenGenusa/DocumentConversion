/**
 * CLI smoke test (Windows-first — the console contract is fragile there).
 * Prereq: npm run build. Usage: node tests/e2e/cli-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
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

let failures = 0
function run(name, args, { expectCode, expectFiles = [], expectStderr }) {
  const res = spawnSync(electron, [appEntry, 'convert', ...args], { encoding: 'utf8', timeout: 120000 })
  const problems = []
  if (res.error) problems.push(`could not run: ${res.error.message}`)
  if (res.status !== expectCode) problems.push(`exit ${res.status}, wanted ${expectCode}`)
  for (const f of expectFiles) if (!existsSync(f)) problems.push(`missing output ${f}`)
  if (expectStderr && !res.stderr.includes(expectStderr)) problems.push(`stderr missing "${expectStderr}"`)
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
