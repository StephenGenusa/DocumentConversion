import textile from 'textile-js'
import { ConversionError } from '../errors'
import { sanitizeToHub } from '../allowlist'
import { stripUnresolvableImageSrc } from './md'
import { decodeTextBytes } from './txt'
import type { HubDocument, SourceInput } from '../types'

/**
 * Textile (spec D12), read with textile-js. Its tree (JsonML) is rewritten
 * before it is written out, so nothing here parses HTML back:
 *
 *   note[1]   <sup class="footnote" id="fnr1"><a href="#fn1">1</a></sup>
 *             -> <sup data-fn="1">1</sup>
 *   fn1. …    <p class="footnote" id="fn1"><a href="#fnr1"><sup>1</sup></a> …</p>
 *             -> one item of the F1 notes list, which goes last
 *
 * `[^sup^]` and `[~sub~]` already come out as <sup> and <sub>. Raw HTML in the
 * source is passed through, and sanitised with the rest.
 */

type JsonML = string | [string, ...JsonMLChild[]]
type JsonMLChild = JsonML | Record<string, string>

const hasAttrs = (el: JsonML): boolean => typeof el !== 'string' && typeof el[1] === 'object' && !Array.isArray(el[1])
const attrsOf = (el: JsonML): Record<string, string> => (hasAttrs(el) ? (el[1] as Record<string, string>) : {})
const childrenOf = (el: JsonML): JsonML[] => (typeof el === 'string' ? [] : (el.slice(hasAttrs(el) ? 2 : 1) as JsonML[]))

const isFootnote = (el: JsonML, id: RegExp): RegExpExecArray | null =>
  typeof el !== 'string' && /\bfootnote\b/.test(attrsOf(el).class ?? '') ? id.exec(attrsOf(el).id ?? '') : null

/** Footnote references in the hub's form, all the way down. */
function mapRefs(el: JsonML): JsonML {
  if (typeof el === 'string') return el
  const ref = el[0] === 'sup' ? isFootnote(el, /^fnr(\d+)$/) : null
  if (ref) return ['sup', { 'data-fn': ref[1] }, ref[1]]
  const kids = childrenOf(el).map(mapRefs)
  return hasAttrs(el) ? [el[0], attrsOf(el), ...kids] : [el[0], ...kids]
}

/** An element's text, for the title. */
function plainText(el: JsonML): string {
  return typeof el === 'string' ? el : childrenOf(el).map(plainText).join('')
}

export async function readTextile(src: SourceInput): Promise<HubDocument> {
  const text = decodeTextBytes(src.bytes)
  let blocks: JsonML[]
  try {
    blocks = (textile.jsonml(text) as JsonML[]).slice(1)
  } catch (err) {
    throw new ConversionError('read-failed', `Could not read Textile: ${(err as Error).message}`)
  }
  const body: JsonML[] = []
  const notes: JsonML[] = []
  for (const block of blocks) {
    const def = block[0] === 'p' ? isFootnote(block, /^fn(\d+)$/) : null
    if (!def) {
      body.push(mapRefs(block))
      continue
    }
    // Drop textile's back-link (<a href="#fnr1"><sup>1</sup></a>) and the space after it.
    const kids = childrenOf(block)
    const start = typeof kids[0] !== 'string' && kids[0]?.[0] === 'a' ? (kids[1] === ' ' ? 2 : 1) : 0
    notes.push(['li', { 'data-fn': def[1] }, ['p', ...kids.slice(start).map(mapRefs)]])
  }
  if (notes.length > 0) body.push('\n', ['ol', ...notes])
  const html = body.map((el) => textile.serialize(el)).join('')
  const h1 = blocks.find((b) => typeof b !== 'string' && b[0] === 'h1')
  const title = h1 ? plainText(h1).replace(/\s+/g, ' ').trim() : ''
  return { html: sanitizeToHub(stripUnresolvableImageSrc(html)), title: title || src.filename?.split(/[\\/]/).pop() }
}
