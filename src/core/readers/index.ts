import type { HubDocument, ReadContext, SourceFormat, SourceInput } from '../types'
import { ConversionError } from '../errors'
import { readTxt } from './txt'
import { readMarkdown } from './md'
import { readHtml } from './html'
import { readDocx } from './docx'
import { readPdf } from './pdf'
import { readCsv } from './csv'
import { readXlsx } from './xlsx'
import { readCode } from './code'
import { readImage } from './image'
import { readRtf } from './rtf'
import { readEml } from './eml'
import { readMsg } from './msg'
import { readIpynb } from './ipynb'
import { readPptx } from './pptx'
import { readDoc } from './doc'
import { readEpub } from './epub'
import { readMbox } from './mbox'
import { readOdt } from './odt'
import { readOdp } from './odp'
import { readIcs } from './ics'
import { readAsciidoc } from './asciidoc'
import { readRst } from './rst'
import { readJson, readJsonRows } from './json'
import { readSubtitles } from './subtitles'
import { readOpml } from './opml'
import { readVcard, readVcardRows } from './vcard'
import type { RowSource } from '../records'

export type Reader = (src: SourceInput, ctx?: ReadContext) => Promise<HubDocument>

const registered: Partial<Record<SourceFormat, Reader>> = {
  txt: readTxt,
  md: readMarkdown,
  html: readHtml,
  docx: readDocx,
  pdf: readPdf,
  csv: readCsv,
  xlsx: readXlsx,
  code: readCode,
  image: readImage,
  rtf: readRtf,
  eml: readEml,
  msg: readMsg,
  ipynb: readIpynb,
  pptx: readPptx,
  doc: readDoc,
  epub: readEpub,
  mbox: readMbox,
  odt: readOdt,
  odp: readOdp,
  ics: readIcs,
  asciidoc: readAsciidoc,
  rst: readRst,
  json: readJson,
  subtitles: readSubtitles,
  opml: readOpml,
  vcard: readVcard,
}

export function getReader(format: SourceFormat): Reader {
  const reader = registered[format]
  if (!reader) throw new ConversionError('read-failed', `No reader available for "${format}" yet`)
  return reader
}

/**
 * Record sources' row readers, for csv/json/xlsx export without the hub
 * (see records.ts). Null from a reader means "not records after all", and
 * the ordinary hub path is taken.
 */
export type RowReader = (src: SourceInput, ctx?: ReadContext) => Promise<RowSource[] | null>

const rowReaders: Partial<Record<SourceFormat, RowReader>> = {
  json: readJsonRows,
  vcard: readVcardRows,
}

export function getRowReader(source: SourceFormat): RowReader | undefined {
  return rowReaders[source]
}

