import { renderDocumentShell } from '../shell'
import type { ConvertOptions, HubDocument } from '../types'

export async function writeHtml(doc: HubDocument, opts?: ConvertOptions): Promise<Buffer> {
  return Buffer.from(renderDocumentShell(doc, { target: 'html', codeColor: opts?.codeColor }), 'utf8')
}
