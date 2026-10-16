import { getReader } from './readers'
import { sanitizeToHub } from './allowlist'
import { ConversionError } from './errors'
import { isEditableTextFormat } from './types'
import { guessCodeLanguages, pastedCodeLanguage } from './code-language'
import { escapeHtml } from './shell'

/**
 * Render pasted text to the sanitized hub HTML the edit pane takes.
 *
 * The reader is the one the converter itself would use, so the pane previews
 * what the conversion will start from rather than a second, similar rendering
 * that could drift from it.
 *
 * The result is sanitized here rather than trusted from the reader. This string
 * crosses into the renderer and is parsed there, and the pane's contract is that
 * it only ever receives hub-safe HTML — so the guarantee is made at the boundary
 * that crosses, not spread across each reader.
 */
export async function renderEditableText(text: string, format: string): Promise<string> {
  if (!isEditableTextFormat(format)) {
    throw new ConversionError('read-failed', `"${format}" is not editable text`)
  }
  // Text that is code and nothing else — from a terminal, an editor or a
  // notebook cell — is one code block in its language. Read as markdown, a
  // Python `# comment` became a heading and the indentation was lost; read as
  // text it was paragraphs, and nothing was highlighted either way.
  const normalized = text.replace(/\r\n?/g, '\n')
  const language = pastedCodeLanguage(normalized)
  if (language) {
    const code = normalized.replace(/^\n+|\s+$/g, '')
    return sanitizeToHub(`<pre><code class="language-${language}">${escapeHtml(code)}</code></pre>`)
  }
  const { html } = await getReader(format)({ bytes: Buffer.from(text, 'utf8') })
  return guessCodeLanguages(sanitizeToHub(html))
}
