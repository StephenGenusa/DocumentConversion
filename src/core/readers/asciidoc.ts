import { ConversionError } from '../errors'
import { sanitizeToHub } from '../allowlist'
import type { HubDocument, SourceInput } from '../types'

export async function readAsciidoc(src: SourceInput): Promise<HubDocument> {
  const text = src.bytes.toString('utf8').replace(/^﻿/, '')
  let html: string
  try {
    const asciidoctor = await import('asciidoctor')
    html = String(await asciidoctor.convert(text, { safe: 'safe', standalone: false }))
  } catch (err) {
    throw new ConversionError('read-failed', `Could not convert AsciiDoc: ${(err as Error).message}`)
  }
  // The document title (= Title) is a header attribute, not part of the body.
  const title = /^=\s+(.+)$/m.exec(text)?.[1]?.trim()
  return { html: sanitizeToHub(html), title: title || src.filename?.split(/[\\/]/).pop() }
}
