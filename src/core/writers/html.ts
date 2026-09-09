import { renderDocumentShell } from '../shell'
import type { HubDocument } from '../types'

export async function writeHtml(doc: HubDocument): Promise<Buffer> {
  return Buffer.from(renderDocumentShell(doc, { target: 'html' }), 'utf8')
}
