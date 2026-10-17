import { parse, renderHTML, type AstNode, type Doc, type HTMLRenderer, type Inline, type Para } from '@djot/djot'
import { ConversionError } from '../errors'
import { sanitizeToHub } from '../allowlist'
import { safeLabel } from '../footnotes'
import { stripUnresolvableImageSrc } from './md'
import { decodeTextBytes } from './txt'
import type { HubDocument, SourceInput } from '../types'

/**
 * Djot (spec D11): rendered by @djot/djot, with the renderer's own markup for
 * the things the hub models differently replaced as it is written, so nothing
 * here parses HTML back.
 *
 *   $`x` / $$`x`        -> the B1 math forms, the TeX as written
 *   [^label] notes      -> F1: the author's label kept, one notes list, last;
 *                          a note nothing cites is kept after the cited ones
 *   - [ ] / - [x]       -> "☐ " / "☑ ", as GitHub task lists are read (A3)
 *   ::: divs, sections  -> unwrapped, contents kept
 *   {-struck-}          -> <s>
 *
 * `^sup^` and `~sub~` are Djot's own syntax and already come out as <sup> and
 * <sub>. Raw HTML (`{=html}`) is passed through and sanitized with the rest.
 */

/** The characters @djot/djot's inline parser stops a run of text at (its `reSpecial`). */
const SPECIAL = /[\r\n"'()*+.:<=[\\\]^_`${}~-]/

/**
 * Put back the text @djot/djot 0.3.2 loses before an image.
 *
 * Its parser turns the `!` of `![` into the image's marker by replacing the
 * match before the `[`, assuming that match is the `!` alone. It is the whole
 * run of plain text that ends in it, so "See the chart ![c](c.png)" read as
 * just the picture. The run reaches back to the previous special character,
 * the previous inline or the start of the block, which source positions give
 * exactly; the positions are then removed, or every tag would carry them.
 */
function restoreTextBeforeImages(node: AstNode, source: string): void {
  const kids = 'children' in node ? (node.children as AstNode[]) : []
  for (let i = 0; i < kids.length; i++) {
    const img = kids[i]
    if (img.tag !== 'image' || !img.pos) continue
    const bang = img.pos.start.offset - 1
    const prev = kids[i - 1]
    let t = bang
    const floor = prev?.pos ? prev.pos.end.offset + 1 : (node.pos?.start.offset ?? 0)
    while (t > floor && !SPECIAL.test(source[t - 1])) t--
    let run = source.slice(t, bang)
    if (!prev || prev.tag === 'soft_break') {
      // The block's own markup on its first line, and indentation, are not text.
      if (node.tag === 'heading') run = run.replace(/^#+/, '')
      if (node.tag === 'cell') run = run.replace(/^\|/, '')
      run = run.trimStart()
    }
    if (run === '') continue
    if (prev?.tag === 'str') prev.text += run
    else kids.splice(i++, 0, { tag: 'str', text: run } as AstNode)
  }
  for (const k of kids) restoreTextBeforeImages(k, source)
  delete node.pos
}

/** A node's text, for the title. */
function plainText(node: AstNode): string {
  if ('text' in node && typeof node.text === 'string') return node.text
  if (node.tag === 'soft_break' || node.tag === 'hard_break') return ' '
  return 'children' in node ? (node.children as AstNode[]).map(plainText).join('') : ''
}

export async function readDjot(src: SourceInput): Promise<HubDocument> {
  const text = decodeTextBytes(src.bytes)
  // Per note label: its number (order of first reference) and its hub label.
  const notes = new Map<string, { n: number; label: string }>()
  const taken = new Set<string>()
  const note = (raw: string) => {
    let found = notes.get(raw)
    if (!found) {
      found = { n: notes.size + 1, label: safeLabel(raw, taken) }
      notes.set(raw, found)
    }
    return found
  }

  /**
   * Display math is an inline in Djot, but its hub form is a block: a <pre>
   * inside a <p> is not html, so the paragraph is split around it.
   */
  const para = (node: Para, r: HTMLRenderer): string => {
    if (!node.children.some((c) => c.tag === 'display_math')) return r.renderAstNodeDefault(node)
    let out = ''
    let run: Inline[] = []
    const flush = () => {
      // The line breaks either side of the formula go with it.
      while (run[0]?.tag === 'soft_break') run.shift()
      while (run[run.length - 1]?.tag === 'soft_break') run.pop()
      if (run.length > 0) out += r.renderAstNodeDefault({ ...node, children: run })
      run = []
    }
    for (const c of node.children) {
      if (c.tag !== 'display_math') {
        run.push(c)
        continue
      }
      flush()
      out += r.renderAstNode(c)
    }
    flush()
    return out
  }

  let html: string
  let doc: Doc
  try {
    doc = parse(text, { sourcePositions: true })
    restoreTextBeforeImages(doc, text)
    for (const fn of Object.values(doc.footnotes)) restoreTextBeforeImages(fn, text)
    html = renderHTML(doc, {
      overrides: {
        doc: (node, r) => {
          let out = r.renderChildren(node)
          // A note may cite another, so render until no new label appears.
          const rendered = new Map<string, string>()
          for (let more = true; more; ) {
            more = false
            for (const raw of [...notes.keys()]) {
              if (rendered.has(raw) || !node.footnotes[raw]) continue
              rendered.set(raw, r.renderChildren(node.footnotes[raw]))
              more = true
            }
          }
          for (const raw of Object.keys(node.footnotes)) {
            if (!rendered.has(raw)) rendered.set(raw, r.renderChildren(node.footnotes[raw]))
          }
          const items = [...rendered].map(([raw, body]) => `<li data-fn="${note(raw).label}">${body.trim()}</li>`)
          if (items.length > 0) out += `<ol>${items.join('')}</ol>`
          return out
        },
        footnote_reference: (node) => {
          const { n, label } = note(node.text)
          return `<sup data-fn="${label}">${n}</sup>`
        },
        inline_math: (node, r) => `<code class="language-math">${r.escape(node.text)}</code>`,
        display_math: (node, r) => `<pre><code class="language-math">${r.escape(node.text)}</code></pre>\n`,
        para,
        task_list_item: (node, r) => {
          const box = node.checkbox === 'checked' ? '☑ ' : '☐ '
          const [first, ...rest] = node.children
          const children = first?.tag === 'para' ? [{ ...first, children: [{ tag: 'str', text: box } as Inline, ...first.children] }, ...rest] : node.children
          const body = r.renderChildren({ children })
          return `<li>${first?.tag === 'para' ? body.trim() : box + body.trim()}</li>\n`
        },
        div: (node, r) => r.renderChildren(node),
        section: (node, r) => r.renderChildren(node),
        delete: (node, r) => `<s>${r.renderChildren(node)}</s>`,
      },
    })
  } catch (err) {
    throw new ConversionError('read-failed', `Could not read Djot: ${(err as Error).message}`)
  }
  const h1 = firstH1(doc.children)
  const title = h1 ? plainText(h1).replace(/\s+/g, ' ').trim() : ''
  return { html: sanitizeToHub(stripUnresolvableImageSrc(html)), title: title || src.filename?.split(/[\\/]/).pop() }
}

/** The first level-1 heading, looking inside the sections Djot wraps headings in. */
function firstH1(blocks: AstNode[]): AstNode | undefined {
  for (const b of blocks) {
    if (b.tag === 'heading' && b.level === 1) return b
    if (b.tag === 'section') {
      const inner = firstH1(b.children)
      if (inner) return inner
    }
  }
  return undefined
}
