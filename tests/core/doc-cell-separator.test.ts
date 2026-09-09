/**
 * Legacy .doc cell marks.
 *
 * word-extractor maps the Word cell mark AND the row mark to "\t", and the doc
 * reader deliberately refuses to rebuild a grid out of that (see
 * DOC_TABLES_ADVICE). But refusing to rebuild the grid is not a licence to hide
 * where one cell ended and the next began: dropped into a `<p>`, HTML collapses
 * the tab to a single space and "28.0 MAX" + "21.0 EXC" arrive glued together
 * as "28.0 MAX 21.0 EXC".
 *
 * These tests pin a VISIBLE boundary that survives into the CSS-less targets
 * (txt, md, docx) as well as html, and pin the limits of it: a tab at the start
 * of a line is still indentation, and a trailing row mark is not a cell.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import JSZip from 'jszip'
import { join } from 'node:path'
import { docBodyToHub, readDoc, DOC_CELL_SEPARATOR } from '../../src/core/readers/doc'
import { writeTxt } from '../../src/core/writers/txt'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeDocx } from '../../src/core/writers/docx'

const CORPUS = join(__dirname, '../corpus')
const FIXTURE = join(CORPUS, 'loan-calculations.doc')
const describeIfFixture = existsSync(FIXTURE) ? describe : describe.skip

async function loanCalculations(): Promise<string> {
  const name = 'loan-calculations.doc'
  const hub = await readDoc({ bytes: await readFile(join(CORPUS, name)), filename: name })
  return hub.html
}

describe('docBodyToHub cell boundaries', () => {
  it('separates two cells on one line', () => {
    expect(docBodyToHub('Bolt\t10').html).toBe('<p>Bolt | 10</p>')
  })

  it('exports the separator it uses, so the writers can be tested against it', () => {
    expect(DOC_CELL_SEPARATOR).toBe(' | ')
  })

  it('does not leave a dangling separator for the row mark', () => {
    // word-extractor maps the ROW mark to "\t" too, so a one-column row arrives
    // as "NETWORK\t". A trailing separator would imply a second, empty cell.
    expect(docBodyToHub('NETWORK\t').html).toBe('<p>NETWORK</p>')
    expect(docBodyToHub('76.8 MAX\t \t \t \t \t').html).toBe('<p>76.8 MAX</p>')
  })

  it('collapses a run of empty cells to a single boundary', () => {
    // Four tabs here are Word padding out the row; the reader cannot tell how
    // many columns that really was, so it marks the boundary once and no more.
    expect(docBodyToHub('7.2 MAX\t \t \t \t20.0 EXC').html).toBe('<p>7.2 MAX | 20.0 EXC</p>')
  })

  it('leaves a leading tab as the indentation it is', () => {
    // isCellLine's rule: a tab at the start of a line is paragraph indentation,
    // which ordinary prose uses constantly, and never a cell mark.
    expect(docBodyToHub('\tIndented paragraph.').html).toBe('<p>Indented paragraph.</p>')
    expect(docBodyToHub('\t\tDM =\tKh/Rkh  **Where Rkh = watt hours per revolution').html).toBe(
      '<p>DM =\tKh/Rkh  **Where Rkh = watt hours per revolution</p>',
    )
  })

  it('still escapes markup inside a cell', () => {
    expect(docBodyToHub('a < b\tc & d').html).toBe('<p>a &lt; b | c &amp; d</p>')
  })

  it('leaves tabless prose exactly as it was', () => {
    expect(docBodyToHub('An ordinary sentence.').html).toBe('<p>An ordinary sentence.</p>')
  })
})

describeIfFixture('loan-calculations.doc table rows', () => {
  it('no longer glues cells together', async () => {
    const html = await loanCalculations()
    expect(html).toContain('<p>28.0 MAX | 21.0 EXC</p>')
    expect(html).toContain('<p>GRADE 220 | 14.0 EXC</p>')
    expect(html).toContain('<p>90 | 7.0 EXC</p>')
    expect(html).toContain('<p>STANDARD | 3 WEEKS</p>')
    // The exact strings the defect report quoted must be gone.
    expect(html).not.toContain('28.0 MAX 21.0 EXC')
    expect(html).not.toContain('90 7.0 EXC')
  })

  it('still refuses to invent a grid', async () => {
    // The boundary is a boundary, not a reconstruction: no table, no rows.
    const html = await loanCalculations()
    expect(html).not.toContain('<table')
    expect(html).not.toContain('<td')
  })
})

describeIfFixture('the boundary survives the CSS-less targets', () => {
  it('reaches plain text', async () => {
    const txt = (await writeTxt({ html: await loanCalculations() })).toString('utf8')
    expect(txt).toContain('28.0 MAX | 21.0 EXC')
  })

  it('reaches markdown', async () => {
    const md = (await writeMarkdown({ html: await loanCalculations() })).toString('utf8')
    expect(md).toContain('28.0 MAX | 21.0 EXC')
  })

  it('reaches docx', async () => {
    const bytes = await writeDocx({ html: await loanCalculations() })
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('28.0 MAX | 21.0 EXC')
  })
})
