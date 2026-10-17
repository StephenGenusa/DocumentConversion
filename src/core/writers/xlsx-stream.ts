import { crc32, createDeflateRaw, type DeflateRaw } from 'node:zlib'

/*
 * An .xlsx workbook written as it goes: each sheet's rows become XML a run
 * at a time and are deflated as they come, so what is held is the
 * compressed workbook, not a cell object per value and the whole sheet as
 * one string (SheetJS's way: 1.1M rows peaked at 3 GB, and the file it
 * wrote was not compressed).
 *
 * The parts are those of the workbooks SheetJS wrote, less what nothing
 * used (its theme, its metadata part, document properties):
 *
 *   strings   inline (`t="inlineStr"`), as text cells in any spreadsheet
 *             reader; a shared-strings table would have to hold every
 *             distinct string until the end. Excel makes its own table the
 *             first time it saves the file.
 *   numbers   as numbers, written as JavaScript writes them (`1.5`, `1e+21`)
 *   empty     no cell at all, as Excel and LibreOffice import an empty CSV
 *             field (SheetJS wrote an empty text cell, which COUNTA counts)
 *   style     one: Calibri 12, as SheetJS's default
 *   errors    "number stored as text" ignored over the sheet's cells, as
 *             SheetJS did: a table's text that looks like a number stays
 *             text without a warning on every cell
 *
 * The zip is ordinary (sizes in the headers, no data descriptors), with
 * ZIP64 sizes only for a part over 4 GB uncompressed.
 */

export type CellValue = string | number

/** A worksheet being written: rows go in with `row`, then `end`. */
export interface SheetWriter {
  /** Adds one row; when it returns a promise, await it before the next (the compressor is catching up). */
  row(values: readonly CellValue[]): Promise<void> | undefined
  end(): Promise<void>
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** How much sheet XML is gathered before it is handed to the compressor. */
const RUN_CHARS = 1 << 20

const escapeAttr = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))

/**
 * Cell text as OOXML holds it: XML's three, and the characters XML cannot
 * hold (controls but tab and line feed; U+FFFE, U+FFFF) as `_xHHHH_`, the
 * spreadsheet escape - with an `_xHHHH_` that is really in the text escaped
 * itself (`_x005F_`), so it reads back as written.
 */
function cellText(text: string): string {
  return text
    .replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1')
    .replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
    .replace(/[\u0000-\u0008\u000b-\u001f￾￿]/g, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
}

const NEEDS_PRESERVE = /^\s|\s$|[\t\n\r]/

/** Column letters, A to XFD, made once each. */
const columns: string[] = []
function column(i: number): string {
  let name = columns[i]
  if (name === undefined) {
    name = ''
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
    columns[i] = name
  }
  return name
}

interface Entry {
  name: string
  crc: number
  size: number
  compressedSize: number
  offset: number
  method: number
}

const MAX32 = 0xffffffff

/** A zip file built in memory, from parts that are compressed as they are written. */
class Zip {
  private readonly parts: Array<{ entry: Entry; data: Buffer[] }> = []
  private open = false

  /** `zip64Above`: the size past which a part's sizes are ZIP64 ones (4 GB, smaller in tests). */
  constructor(private readonly zip64Above = MAX32) {}

  /** A whole part at once, deflated. */
  async file(name: string, text: string): Promise<void> {
    const w = this.stream(name)
    await w.write(Buffer.from(text, 'utf8'))
    await w.end()
  }

  /** A part written in pieces: each piece deflated as it comes, the entry added at `end`. */
  stream(name: string): { write(data: Buffer): Promise<void> | undefined; end(): Promise<void> } {
    if (this.open) throw new Error('one zip entry at a time')
    this.open = true
    const deflate: DeflateRaw = createDeflateRaw({ level: 1 })
    const data: Buffer[] = []
    let compressedSize = 0
    let crc = 0
    let size = 0
    let failed: Error | undefined
    deflate.on('data', (b: Buffer) => {
      data.push(b)
      compressedSize += b.length
    })
    const ended = new Promise<void>((resolve, reject) => {
      deflate.on('end', resolve)
      deflate.on('error', (e) => {
        failed = e
        reject(e)
      })
    })
    // A failure is thrown by the next write or by `end`, never left unhandled.
    ended.catch(() => undefined)
    return {
      write: (chunk) => {
        if (failed) throw failed
        crc = crc32(chunk, crc)
        size += chunk.length
        if (deflate.write(chunk)) return undefined
        return new Promise<void>((resolve) => deflate.once('drain', resolve))
      },
      end: async () => {
        deflate.end()
        await ended
        this.open = false
        this.parts.push({ entry: { name, crc, size, compressedSize, offset: 0, method: 8 }, data })
      },
    }
  }

  /** The zip, its parts in `first`'s order and then as written. */
  end(first: readonly string[] = []): Buffer {
    const rank = (name: string): number => {
      const i = first.indexOf(name)
      return i < 0 ? first.length : i
    }
    const parts = [...this.parts].sort((a, b) => rank(a.entry.name) - rank(b.entry.name))
    const chunks: Buffer[] = []
    let offset = 0
    const push = (b: Buffer): void => {
      chunks.push(b)
      offset += b.length
    }
    for (const { entry, data } of parts) {
      entry.offset = offset
      push(localHeader(entry, this.zip64Above))
      for (const b of data) push(b)
    }
    const start = offset
    for (const { entry } of parts) push(centralHeader(entry, this.zip64Above))
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(parts.length, 8)
    eocd.writeUInt16LE(parts.length, 10)
    eocd.writeUInt32LE(offset - start, 12)
    eocd.writeUInt32LE(start, 16)
    push(eocd)
    return Buffer.concat(chunks)
  }
}

/** 1980-01-01 00:00, the earliest a zip can say: the same bytes for the same workbook. */
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

const needs64 = (e: Entry, above: number): boolean => e.size >= above || e.compressedSize >= above

/** The ZIP64 sizes field, for an entry too large for 32-bit sizes. */
function zip64Sizes(e: Entry): Buffer {
  const b = Buffer.alloc(20)
  b.writeUInt16LE(0x0001, 0)
  b.writeUInt16LE(16, 2)
  b.writeBigUInt64LE(BigInt(e.size), 4)
  b.writeBigUInt64LE(BigInt(e.compressedSize), 12)
  return b
}

function localHeader(e: Entry, above: number): Buffer {
  const name = Buffer.from(e.name, 'utf8')
  const big = needs64(e, above)
  const extra = big ? zip64Sizes(e) : Buffer.alloc(0)
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0)
  h.writeUInt16LE(big ? 45 : 20, 4)
  h.writeUInt16LE(0x0800, 6) // names in UTF-8
  h.writeUInt16LE(e.method, 8)
  h.writeUInt16LE(DOS_TIME, 10)
  h.writeUInt16LE(DOS_DATE, 12)
  h.writeUInt32LE(e.crc >>> 0, 14)
  h.writeUInt32LE(big ? MAX32 : e.compressedSize, 18)
  h.writeUInt32LE(big ? MAX32 : e.size, 22)
  h.writeUInt16LE(name.length, 26)
  h.writeUInt16LE(extra.length, 28)
  return Buffer.concat([h, name, extra])
}

function centralHeader(e: Entry, above: number): Buffer {
  const name = Buffer.from(e.name, 'utf8')
  const big = needs64(e, above)
  const extra = big ? zip64Sizes(e) : Buffer.alloc(0)
  const h = Buffer.alloc(46)
  h.writeUInt32LE(0x02014b50, 0)
  h.writeUInt16LE(big ? 45 : 20, 4)
  h.writeUInt16LE(big ? 45 : 20, 6)
  h.writeUInt16LE(0x0800, 8)
  h.writeUInt16LE(e.method, 10)
  h.writeUInt16LE(DOS_TIME, 12)
  h.writeUInt16LE(DOS_DATE, 14)
  h.writeUInt32LE(e.crc >>> 0, 16)
  h.writeUInt32LE(big ? MAX32 : e.compressedSize, 20)
  h.writeUInt32LE(big ? MAX32 : e.size, 24)
  h.writeUInt16LE(name.length, 28)
  h.writeUInt16LE(extra.length, 30)
  h.writeUInt32LE(e.offset, 42)
  return Buffer.concat([h, name, extra])
}

/** A workbook written sheet by sheet; `end` gives the .xlsx bytes. */
export class XlsxBook {
  private readonly zip: Zip

  /** `zip64Above` is for tests: a size smaller than 4 GB past which a part is written with ZIP64 sizes. */
  constructor(opts: { zip64Above?: number } = {}) {
    this.zip = new Zip(opts.zip64Above)
  }

  private readonly sheets: string[] = []
  private writing = false

  /** Starts the next sheet (the one before must have ended). */
  sheet(name: string): SheetWriter {
    if (this.writing) throw new Error('one sheet at a time')
    this.writing = true
    this.sheets.push(name)
    const part = this.zip.stream(`xl/worksheets/sheet${this.sheets.length}.xml`)
    let run: string[] = []
    let runChars = 0
    let rows = 0
    let widest = 0
    const flush = (): Promise<void> | undefined => {
      const text = run.join('')
      run = []
      runChars = 0
      return part.write(Buffer.from(text, 'utf8'))
    }
    const put = (text: string): Promise<void> | undefined => {
      run.push(text)
      runChars += text.length
      return runChars >= RUN_CHARS ? flush() : undefined
    }
    put(`${XML_HEAD}<worksheet xmlns="${NS}" xmlns:r="${REL_NS}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>`)
    return {
      row: (values) => {
        const r = ++rows
        let xml = `<row r="${r}">`
        for (let c = 0; c < values.length; c++) {
          const v = values[c]
          if (typeof v === 'number') {
            if (Number.isFinite(v)) xml += `<c r="${column(c)}${r}"><v>${v}</v></c>`
            continue
          }
          if (v === '' || v === undefined || v === null) continue
          const text = String(v)
          xml += `<c r="${column(c)}${r}" t="inlineStr"><is><t${NEEDS_PRESERVE.test(text) ? ' xml:space="preserve"' : ''}>${cellText(text)}</t></is></c>`
        }
        if (values.length > widest) widest = values.length
        return put(`${xml}</row>`)
      },
      end: async () => {
        const range = rows > 0 && widest > 0 ? `A1:${column(widest - 1)}${rows}` : ''
        await put(`</sheetData>${range ? `<ignoredErrors><ignoredError numberStoredAsText="1" sqref="${range}"/></ignoredErrors>` : ''}</worksheet>`)
        await flush()
        await part.end()
        this.writing = false
      },
    }
  }

  async end(): Promise<Buffer> {
    if (this.writing) throw new Error('a sheet is still being written')
    const n = this.sheets.length
    const ids = Array.from({ length: n }, (_, i) => i + 1)
    await this.zip.file(
      '[Content_Types].xml',
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${ids
        .map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    )
    await this.zip.file(
      '_rels/.rels',
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    )
    await this.zip.file(
      'xl/workbook.xml',
      `${XML_HEAD}<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews><sheets>${this.sheets
        .map((name, i) => `<sheet name="${escapeAttr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    )
    await this.zip.file(
      'xl/_rels/workbook.xml.rels',
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ids
        .map((i) => `<Relationship Id="rId${i}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i}.xml"/>`)
        .join('')}<Relationship Id="rId${n + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
    )
    await this.zip.file(
      'xl/styles.xml',
      `${XML_HEAD}<styleSheet xmlns="${NS}"><fonts count="1"><font><sz val="12"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0"/></styleSheet>`,
    )
    // The package's own parts first, as Excel writes them, then the workbook and its sheets.
    return this.zip.end(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml'])
  }
}
