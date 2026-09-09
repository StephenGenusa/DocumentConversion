import { ConversionError } from '../errors'
import { readEml } from './eml'
import type { HubDocument, ReadContext, SourceInput } from '../types'

/**
 * Split an mbox on its `From ` separator lines (the "From_" line), which start
 * a message at column 0. Body lines that legitimately begin with "From " are
 * stored quoted as ">From " — unescape those rather than splitting on them.
 */
export function splitMbox(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const messages: string[] = []
  let current: string[] | null = null
  for (const line of lines) {
    if (/^From \S+/.test(line)) {
      if (current) messages.push(current.join('\n'))
      current = []
      continue
    }
    // mboxrd quoting: ">From ", ">>From " ... each lose one level.
    if (current) current.push(line.replace(/^>(>*From )/, '$1'))
  }
  if (current) messages.push(current.join('\n'))
  return messages.filter((m) => m.trim() !== '')
}

export async function readMbox(src: SourceInput, ctx?: ReadContext): Promise<HubDocument> {
  const messages = splitMbox(src.bytes.toString('utf8'))
  if (messages.length === 0) throw new ConversionError('eml-parse-failed', 'No messages found in this mbox')

  const sections: string[] = []
  for (let i = 0; i < messages.length; i++) {
    ctx?.onProgress?.(`Reading message ${i + 1} of ${messages.length}`, ((i + 1) / messages.length) * 100)
    try {
      const hub = await readEml({ bytes: Buffer.from(messages[i], 'utf8') })
      sections.push(hub.html)
    } catch {
      // One unreadable message must not lose the rest of the archive.
      sections.push('<p><em>[unreadable message]</em></p>')
    }
  }
  const name = src.filename?.split(/[\\/]/).pop()
  return { html: sections.join('\n<hr>\n'), title: name }
}
