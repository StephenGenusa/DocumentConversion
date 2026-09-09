import type { ConvertOptions, HubDocument, RenderHtmlToPdf, TargetFormat, WriteResult } from '../types'
import { writeTxt } from './txt'
import { writeMarkdown } from './md'
import { writeHtml } from './html'
import { writeEpub } from './epub'
import { writeRevealJs } from './revealjs'
import { writeAzw3 } from './azw3'
import { createAzw4Writer } from './azw4'
import { writeDocx } from './docx'
import { createPdfWriter } from './pdf'
import { writeCsv } from './csv'
import { writeJson } from './json'
import { writeXlsx } from './xlsx'

export type Writer = (doc: HubDocument, opts?: ConvertOptions) => Promise<WriteResult>

/** Adapt a single-buffer writer to the multi-part contract. */
const single =
  (fn: (doc: HubDocument, opts?: ConvertOptions) => Promise<Buffer>): Writer =>
  async (doc, opts) => ({ parts: [{ suffix: '', bytes: await fn(doc, opts) }] })

export function createWriters(render: RenderHtmlToPdf): Record<TargetFormat, Writer> {
  return {
    txt: single(writeTxt),
    md: single(writeMarkdown),
    html: single(writeHtml),
    epub: single(writeEpub),
    revealjs: single(writeRevealJs),
    azw3: single(writeAzw3),
    azw4: single(createAzw4Writer(render)),
    docx: single(writeDocx),
    pdf: single(createPdfWriter(render)),
    csv: writeCsv,
    json: writeJson,
    xlsx: writeXlsx,
  }
}
