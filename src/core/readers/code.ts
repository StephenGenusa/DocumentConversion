import { escapeHtml } from '../shell'
import { languageForFilename } from '../code-langs'
import type { HubDocument, SourceInput } from '../types'

/** "Print this file for review": one fenced block, filename as heading. */
export async function readCode(src: SourceInput): Promise<HubDocument> {
  const filename = src.filename ?? 'code'
  const language = languageForFilename(filename) ?? 'plaintext'
  // Strip the BOM and normalize CRLF; a literal CR leaks into docx/txt output.
  const text = src.bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const name = filename.split(/[\\/]/).pop() ?? filename
  return {
    html: `<h1>${escapeHtml(name)}</h1>\n<pre><code class="language-${language}">${escapeHtml(text)}</code></pre>`,
    title: name,
    language,
  }
}
