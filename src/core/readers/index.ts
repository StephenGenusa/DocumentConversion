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
}

export function getReader(format: SourceFormat): Reader {
  const reader = registered[format]
  if (!reader) throw new ConversionError('read-failed', `No reader available for "${format}" yet`)
  return reader
}
