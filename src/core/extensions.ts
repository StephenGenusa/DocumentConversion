import type { SourceFormat } from './types'

/**
 * Extension → format, for detect.ts and the start screen's list of what the
 * app reads (input-formats.ts); pure data, so the page can import it.
 *
 * A Map, not an object literal: the key comes off a filename, and a plain
 * literal inherits `Object.prototype`, so a file called `report.constructor`
 * would look up a FUNCTION and `?? null` would keep it.
 */
export const EXTENSION_FORMATS: ReadonlyMap<string, SourceFormat> = new Map<string, SourceFormat>(
  Object.entries({
    txt: 'txt',
    text: 'txt',
    md: 'md',
    markdown: 'md',
    mdown: 'md',
    mkd: 'md',
    mkdn: 'md',
    mdwn: 'md',
    markdn: 'md',
    // R Markdown and Quarto: Markdown with code chunks (see readers/md.ts).
    rmd: 'md',
    qmd: 'md',
    // JSON records and JSON Lines (readers/json.ts). .jsonc and .json5 are
    // code: comments and bare words rule out a table.
    json: 'json',
    jsonl: 'json',
    ndjson: 'json',
    docx: 'docx',
    pdf: 'pdf',
    html: 'html',
    htm: 'html',
    csv: 'csv',
    tsv: 'csv',
    xlsx: 'xlsx',
    // SheetJS reads legacy .xls and OpenDocument .ods with the same reader.
    xls: 'xlsx',
    ods: 'xlsx',
    odt: 'odt',
    odp: 'odp',
    ics: 'ics',
    ical: 'ics',
    adoc: 'asciidoc',
    asciidoc: 'asciidoc',
    asc: 'asciidoc',
    rst: 'rst',
    // WebVTT and SRT subtitles, and Teams meeting transcripts (readers/subtitles.ts).
    vtt: 'subtitles',
    srt: 'subtitles',
    opml: 'opml',
    // Contacts. A .vcf is also the genomics Variant Call Format: see detect().
    vcf: 'vcard',
    vcard: 'vcard',
    djot: 'djot',
    dj: 'djot',
    textile: 'textile',
    // SQLite databases go by their magic bytes (see detect()). These names
    // without it are still databases, encrypted ones (SQLCipher encrypts the
    // header too), and are refused with that message rather than read as
    // text. A .db is not among them: the name is used by too many other
    // formats (Thumbs.db is a CFB file), so one without the magic is not SQLite.
    sqlite: 'sqlite',
    sqlite3: 'sqlite',
    db3: 'sqlite',
    // mammoth reads macro-enabled Word documents like any other .docx.
    docm: 'docx',
    ipynb: 'ipynb',
    msg: 'msg',
    pptx: 'pptx',
    pptm: 'pptx',
    doc: 'doc',
    epub: 'epub',
    mbox: 'mbox',
    rtf: 'rtf',
    eml: 'eml',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    // SVG is text, so it is sniffed by its first element (looksLikeSvg), not by magic bytes.
    svg: 'svg',
  } satisfies Record<string, SourceFormat>),
)
