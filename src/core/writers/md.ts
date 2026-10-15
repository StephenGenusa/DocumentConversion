import TurndownService from 'turndown'
// @ts-ignore -- turndown-plugin-gfm ships no types; resolution differs between tsconfigs
import { tables, strikethrough } from 'turndown-plugin-gfm'
import { parseDocument } from 'htmlparser2'
import { findAll, removeElement, replaceElement } from 'domutils'
import { Element, Text } from 'domhandler'
import render from 'dom-serializer'
import { gridForElement } from '../table-grid'
import type { HubDocument } from '../types'
import { TEX_SHAPED } from '../rendered-blocks'

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
td.use([tables, strikethrough])
// No Markdown syntax for these; GitHub and most renderers accept the HTML.
td.keep(['sup', 'sub'])
// turndown-plugin-gfm writes `~text~`, which only GitHub-style readers take;
// `~~` is read by all of them, this app's own reader included. Added after
// the plugin, so it is the rule turndown tries first.
td.addRule('strikethroughDouble', {
  // A function, not a tag list: <strike> is obsolete and not in the DOM's tag-name types.
  filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
  replacement: (content) => `~~${content}~~`,
})

/**
 * Unicode private-use area: never appears in real content, ignored by turndown.
 * A rendered table is parked under one of these while turndown converts the
 * prose around it, then spliced back in.
 */
const TABLE_SENTINEL = '\uE001'
const SENTINEL_RE = /([^\n]*)\uE001(\d+)\uE001/g

/**
 * Cheap pre-test for turndown's escape list: a backslash, asterisk, backtick,
 * underscore or square bracket anywhere, or a leading dash, plus, equals, hash,
 * angle bracket, tilde or ordered-list marker. Spreadsheet cells are
 * overwhelmingly plain words and numbers, and skipping thirteen regex passes on
 * those is most of the escaping cost on a 300k-cell workbook.
 */
const NEEDS_ESCAPE = /[\\*`[\]_]|^[-+=#>~]|^\d+\. /

function escapeCell(value: string): string {
  const escaped = NEEDS_ESCAPE.test(value) ? td.escape(value) : value
  // A literal pipe would be read as a column separator and shift the row.
  // Escape after turndown's escaping so a real backslash is doubled first.
  return escaped.includes('|') ? escaped.replace(/\|/g, '\\|') : escaped
}

/**
 * One GFM row. Matches turndown-plugin-gfm's `cell()` exactly: the first cell
 * carries "| ", the rest a single space, and every cell ends " |" — so an empty
 * cell renders as two spaces between pipes.
 */
function pipeRow(cells: string[], width: number): string {
  let out = ''
  for (let i = 0; i < width; i++) out += (i === 0 ? '| ' : ' ') + escapeCell(cells[i] ?? '') + ' |'
  return out
}

/**
 * Render the grid as a GFM pipe table, byte-identical to what turndown plus
 * turndown-plugin-gfm produced for the same grid.
 *
 * Row 0 is the header. GFM requires one, and a blank header is strictly worse
 * than the real first row: mammoth emits docx header rows as plain <td>, and
 * synthesizing an empty header demoted every real header row.
 *
 * Handing whole tables to turndown was the single reason `xlsx -> md` took
 * 12.5s where `xlsx -> html` took 2.7s: turndown accumulates its output with
 * `join()`, which indexes into the string built so far, forcing V8 to flatten
 * the whole rope on every one of the 300k cells. That is quadratic in the
 * output size, and it also materialised a second full DOM (turndown parses the
 * HTML again with domino), which is where the 1.4 GB peak came from.
 */
function renderPipeTable(grid: string[][]): string {
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0)
  const lines: string[] = [pipeRow(grid[0], width)]
  let border = ''
  for (let i = 0; i < width; i++) border += (i === 0 ? '| ' : ' ') + '---' + ' |'
  lines.push(border)
  for (let r = 1; r < grid.length; r++) lines.push(pipeRow(grid[r], width))
  return lines.join('\n')
}

/**
 * Replace every table with a placeholder paragraph and return the markdown each
 * one should become.
 *
 * GFM pipe tables are rectangular, header-led, single-line and pipe-delimited,
 * while hub HTML has none of those guarantees: asciidoctor wraps cells in <p>,
 * email/calendar/headerless-CSV tables have no <thead>, colspan makes the
 * header narrower than the body (GFM then TRUNCATES the extra cells), rows are
 * ragged, and a cell may itself contain a "|". Rendering from the grid — which
 * already expands spans and pads rows — makes all of those safe at once.
 *
 * The placeholder is a <p>, whose turndown rule emits the same "\n\n...\n\n"
 * the gfm table rule does, so the blank lines around the table (and any list or
 * blockquote indentation applied to it) come out unchanged.
 */
function extractTablesForMarkdown(html: string): { prose: string; tableMarkdown: string[] } {
  if (!html.includes('<table')) return { prose: html, tableMarkdown: [] }
  const dom = parseDocument(html)
  const rendered: string[] = []
  for (const table of findAll((el) => el.name === 'table', dom.children)) {
    const grid = gridForElement(table)
    // turndown-plugin-gfm dereferences node.rows[0].parentNode with no guard,
    // so a table with no rows at all (an empty CSV renders one) took the whole
    // conversion down. Nothing can be extracted from it either way.
    if (grid.length === 0) {
      removeElement(table)
      continue
    }
    // Rows that yielded no cells at all: leave the element alone, as before.
    if (grid.every((row) => row.length === 0)) continue
    const marker = `${TABLE_SENTINEL}${rendered.length}${TABLE_SENTINEL}`
    rendered.push(renderPipeTable(grid))
    replaceElement(table, new Element('p', {}, [new Text(marker)]))
  }
  // decodeEntities must stay on: with it off, text that legitimately contains
  // "<ALL CATEGORIES>" is re-emitted raw and turndown deletes it as a tag.
  return { prose: render(dom.children, { decodeEntities: true }), tableMarkdown: rendered }
}

/**
 * Put each rendered table back where its placeholder ended up, carrying the
 * placeholder line's own prefix onto the table's later lines. That is what
 * keeps a table inside a list item or a blockquote indented: turndown indented
 * the single placeholder line, and every line of the table needs the same
 * prefix (list markers become spaces, "> " stays "> ").
 */
function restoreTables(markdown: string, rendered: string[]): string {
  if (rendered.length === 0) return markdown
  return markdown.replace(SENTINEL_RE, (whole, before: string, index: string) => {
    const table = rendered[Number(index)]
    if (table === undefined) return whole
    const indent = before.replace(/[^\t>]/g, ' ')
    return before + (indent ? table.split('\n').join(`\n${indent}`) : table)
  })
}

const ALERT_LABELS: Record<string, string> = {
  Note: 'NOTE',
  Tip: 'TIP',
  Important: 'IMPORTANT',
  Warning: 'WARNING',
  Caution: 'CAUTION',
}

/**
 * The GitHub syntax the reader turned into plain markup, put back.
 *
 *   `*   ☐ todo`              ->  `*   [ ] todo`     (a ballot box opening an item)
 *   `> **Note**` opening a quote  ->  `> [!NOTE]`
 *
 * The reader writes both from that syntax and nothing else does, so the
 * round trip is exact. Line-based, after turndown, and never inside a fenced
 * code block, where those lines are someone's literal text.
 */
function restoreGithubSyntax(markdown: string): string {
  let fence: string | null = null
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null
      continue
    }
    if (opener) {
      fence = opener
      continue
    }
    const task = /^(\s*(?:[*+-]|\d+[.)])\s+)([☐☑]) /.exec(line)
    if (task) {
      lines[i] = `${task[1]}${task[2] === '☐' ? '[ ]' : '[x]'} ${line.slice(task[0].length)}`
      continue
    }
    const alert = /^> \*\*(Note|Tip|Important|Warning|Caution)\*\*\s*$/.exec(line)
    if (alert && !(lines[i - 1] ?? '').startsWith('>')) lines[i] = `> [!${ALERT_LABELS[alert[1]]}]`
  }
  return lines.join('\n')
}

/**
 * Footnotes back to `[^label]`: the reference where it stood, the definitions
 * at the end. A note of several paragraphs indents the rest by four spaces,
 * as Markdown requires. Labels are already safe for this (FOOTNOTE_LABEL).
 */
td.addRule('footnoteRef', {
  filter: (node) => node.nodeName === 'SUP' && !!node.getAttribute('data-fn'),
  replacement: (_content, node) => `[^${(node as HTMLElement).getAttribute('data-fn')}]`,
})
const isNotesList = (node: HTMLElement): boolean => {
  if (node.nodeName !== 'OL') return false
  const items = Array.from(node.children)
  return items.length > 0 && items.every((c) => c.nodeName === 'LI' && !!c.getAttribute('data-fn'))
}
td.addRule('footnoteList', {
  filter: (node) => isNotesList(node),
  replacement: (_content, node) => {
    const defs = Array.from((node as HTMLElement).children).map((li) => {
      const [first, ...rest] = td.turndown((li as HTMLElement).innerHTML).split('\n')
      return [`[^${li.getAttribute('data-fn')}]: ${first}`, ...rest.map((l) => (l === '' ? '' : `    ${l}`))].join('\n')
    })
    return `\n\n${defs.join('\n\n')}\n\n`
  },
})

/*
 * Diagrams and formulas (spec B1) back to the syntax the reader takes them
 * from. A diagram is already a fenced block with its language
 * (```` ```mermaid ````, ```` ```dot ````); math needs its dollars back.
 */
const isMath = (node: Node | null): boolean =>
  node?.nodeName === 'CODE' && /(?:^|\s)language-math(?:\s|$)/.test((node as HTMLElement).getAttribute('class') ?? '')

/**
 * `$TEX$` when the reader will take it back as math (it must look like TeX
 * and hold no `$`), else `$$TEX$$`, which is always math.
 */
function inlineMath(tex: string): string {
  return !tex.includes('$') && TEX_SHAPED.test(tex) ? `$${tex}$` : `$$${tex}$$`
}

/**
 * A line that would end a paragraph or start another block. `$$…$$` is read
 * as display math only while it is one paragraph, so TeX holding one of these
 * is written as a math fence instead.
 */
const BREAKS_PARAGRAPH = /^\s*$|^ {0,3}(?:[-+*>#=|_<]|\d+[.)]|```|~~~)/

function displayMath(tex: string): string {
  const [, ...rest] = tex.split('\n')
  if (!tex.includes('$$') && !rest.some((l) => BREAKS_PARAGRAPH.test(l))) return `$$${tex}$$`
  const ticks = Math.max(2, ...[...tex.matchAll(/`+/g)].map((m) => m[0].length)) + 1
  const fence = '`'.repeat(ticks)
  return `${fence}math\n${tex.replace(/\n$/, '')}\n${fence}`
}

td.addRule('mathInline', {
  filter: (node) => isMath(node) && node.parentNode?.nodeName !== 'PRE',
  replacement: (_content, node) => inlineMath(node.textContent ?? ''),
})
td.addRule('mathBlock', {
  filter: (node) => node.nodeName === 'PRE' && isMath(node.firstChild),
  replacement: (_content, node) => `\n\n${displayMath(node.firstChild?.textContent ?? '')}\n\n`,
})

/**
 * A `$` in prose that the reader would take as opening math, escaped. Without
 * it, "costs $5 for a_b and $10" from a Word file read back as a formula: the
 * escaped underscore makes the span between the dollars look like TeX. The
 * scan is the reader's own, on the text the reader will see; a pair split
 * across two text nodes (`$a <em>b</em> c_d$`) is not caught.
 */
function escapeDollars(text: string): string {
  if (!text.includes('$')) return text
  let out = ''
  let i = 0
  for (let at = text.indexOf('$'); at !== -1; at = text.indexOf('$', i)) {
    const delim = text.startsWith('$$', at) ? '$$' : '$'
    const close = text.indexOf(delim, at + delim.length)
    const content = close === -1 ? '' : text.slice(at + delim.length, close)
    const opens = content !== '' && (delim === '$$' || TEX_SHAPED.test(content))
    out += text.slice(i, at) + (opens ? delim.replace(/\$/g, '\\$') : '$')
    i = at + (opens ? delim.length : 1)
  }
  return out + text.slice(i)
}
const turndownEscape = td.escape.bind(td)
td.escape = (text: string): string => escapeDollars(turndownEscape(text))

export async function writeMarkdown(doc: HubDocument): Promise<Buffer> {
  // Strip any stray sentinel from the source so it cannot be mistaken for one
  // of ours. It is a private-use codepoint, so this never touches real content.
  const html = doc.html.includes(TABLE_SENTINEL) ? doc.html.split(TABLE_SENTINEL).join('') : doc.html
  const { prose, tableMarkdown } = extractTablesForMarkdown(html)
  return Buffer.from(restoreGithubSyntax(restoreTables(td.turndown(prose), tableMarkdown)), 'utf8')
}
