import TurndownService from 'turndown'
// @ts-ignore -- turndown-plugin-gfm ships no types; resolution differs between tsconfigs
import { tables, strikethrough } from 'turndown-plugin-gfm'
import { parseDocument } from 'htmlparser2'
import { findAll, removeElement, replaceElement } from 'domutils'
import { Element, Text } from 'domhandler'
import render from 'dom-serializer'
import { gridForElement } from '../table-grid'
import type { HubDocument } from '../types'

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
td.use([tables, strikethrough])

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

export async function writeMarkdown(doc: HubDocument): Promise<Buffer> {
  // Strip any stray sentinel from the source so it cannot be mistaken for one
  // of ours. It is a private-use codepoint, so this never touches real content.
  const html = doc.html.includes(TABLE_SENTINEL) ? doc.html.split(TABLE_SENTINEL).join('') : doc.html
  const { prose, tableMarkdown } = extractTablesForMarkdown(html)
  return Buffer.from(restoreTables(td.turndown(prose), tableMarkdown), 'utf8')
}
