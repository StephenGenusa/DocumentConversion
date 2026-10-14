/**
 * JSON read without being parsed.
 *
 * `JSON.parse` + `stringify` would print a different file: 12345678901234567890
 * comes back as 12345678901234567000, `1.0` as `1`, `1e5` as `100000`, `"é"`
 * as `"é"`, and a key written twice loses its first value with no trace. A
 * printout or a table built from the file must show what the file says, so
 * everything here works on the source text, token by token: strings and
 * numbers are copied verbatim, only the whitespace between tokens changes.
 *
 * Iterative throughout: a file nested 10,000 deep is legal JSON and must not
 * overflow the stack. JSONC comments and JSON5's bare words and single quotes
 * pass through as tokens; nothing is judged except structure.
 */

type Tok =
  | { k: 'open'; c: '{' | '[' }
  | { k: 'close'; c: '}' | ']' }
  | { k: 'colon' }
  | { k: 'comma' }
  | { k: 'value'; text: string; quoted: boolean }
  | { k: 'comment'; text: string; line: boolean }

/** Every token in order, or null when the text cannot be JSON (an unterminated string, a stray close). */
function* tokens(text: string): Generator<Tok, void, undefined> {
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '﻿') {
      i++
      continue
    }
    if (c === '{' || c === '[') {
      yield { k: 'open', c }
      i++
    } else if (c === '}' || c === ']') {
      yield { k: 'close', c }
      i++
    } else if (c === ':') {
      yield { k: 'colon' }
      i++
    } else if (c === ',') {
      yield { k: 'comma' }
      i++
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && text[j] !== c) {
        if (text[j] === '\n') throw new SyntaxError('newline in string')
        j += text[j] === '\\' ? 2 : 1
      }
      if (j >= n) throw new SyntaxError('unterminated string')
      yield { k: 'value', text: text.slice(i, j + 1), quoted: true }
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      const j = end < 0 ? n : end
      yield { k: 'comment', text: text.slice(i, j).trimEnd(), line: true }
      i = j
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) throw new SyntaxError('unterminated comment')
      yield { k: 'comment', text: text.slice(i, end + 2), line: false }
      i = end + 2
    } else {
      let j = i
      while (j < n && !' \n\r\t{}[]:,"\'/'.includes(text[j])) j++
      if (j === i) throw new SyntaxError(`unexpected ${c}`)
      yield { k: 'value', text: text.slice(i, j), quoted: false }
      i = j
    }
  }
}

/**
 * The same JSON, indented two spaces. Empty `{}` and `[]` stay on one line;
 * comments keep their place. Null when the text is not structurally JSON, so
 * the caller can keep the original.
 */
const MAX_INDENT = 40

export function reindentJson(text: string): string | null {
  const out: string[] = []
  const stack: string[] = []
  // Indentation stops growing at MAX_INDENT levels. Past that nobody follows
  // the indent anyway, and without the cap the output grows with the SQUARE
  // of the depth: a file nested 10,000 deep became 200 MB of spaces.
  const pad = (): string => '\n' + '  '.repeat(Math.min(stack.length, MAX_INDENT))
  let pendingOpen: '{' | '[' | null = null
  // A value may only follow an opener, a colon or a comma: two values with
  // nothing between them (`tru e`) are not JSON, and gluing them would
  // change the text.
  let afterValue = false
  const flushOpen = (): void => {
    if (pendingOpen) {
      stack.push(pendingOpen)
      out.push(pendingOpen, pad())
      pendingOpen = null
    }
  }
  try {
    for (const t of tokens(text)) {
      if (t.k === 'open') {
        if (afterValue) return null
        flushOpen()
        pendingOpen = t.c
        continue
      }
      if (t.k === 'close') {
        const want = t.c === '}' ? '{' : '['
        if (pendingOpen === want) {
          out.push(want + t.c)
          pendingOpen = null
          afterValue = true
          continue
        }
        flushOpen()
        if (stack.pop() !== want) return null
        // Drop the indentation already written after the last token.
        if (out.length && /^\n +$|^\n$/.test(out[out.length - 1])) out.pop()
        out.push(pad(), t.c)
        afterValue = true
        continue
      }
      flushOpen()
      if (t.k === 'colon') {
        out.push(': ')
        afterValue = false
      } else if (t.k === 'comma') {
        out.push(',', pad())
        afterValue = false
      } else if (t.k === 'value') {
        if (afterValue) return null
        out.push(t.text)
        afterValue = true
      }
      else {
        out.push(t.text, pad())
      }
    }
  } catch {
    return null
  }
  if (pendingOpen || stack.length) return null
  return out.join('').replace(/[ \t]+\n/g, '\n').trimEnd()
}

/**
 * Whether a file needs re-indenting to be read at all: a line over 500
 * characters, or more than 200 bytes on at most two lines. A file someone
 * formatted by hand is left exactly as it is.
 */
export function needsReformat(text: string): boolean {
  const lines = text.split('\n')
  if (text.length > 200 && lines.filter((l) => l.trim()).length <= 2) return true
  return lines.some((l) => l.length > 500)
}

export interface Records {
  header: string[]
  rows: string[][]
}

/** A JSON string token's text, unescaped, for showing in a cell. */
function stringValue(token: string): string {
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string
    } catch {
      return token.slice(1, -1)
    }
  }
  return token.slice(1, -1)
}

/** The tokens of one nested value, joined with no spacing: `{"k":[1,2]}`. */
function compact(toks: Tok[]): string {
  return toks
    .map((t) => (t.k === 'open' || t.k === 'close' ? t.c : t.k === 'colon' ? ':' : t.k === 'comma' ? ',' : t.k === 'value' ? t.text : ''))
    .join('')
}

/**
 * Records, if `text` is an array of objects (or, for JSON Lines, one object
 * per line). Every value must be a scalar, except that up to a tenth of the
 * fields may be nested; those cells hold the nested value as compact JSON.
 * Numbers and literals are kept as written; a string is shown unquoted;
 * `null` is an empty cell. Columns are keys in first-seen order. Null when the
 * text is not records.
 */
export function readRecords(text: string, opts: { lines?: boolean } = {}): Records | null {
  const header: string[] = []
  const seen = new Map<string, number>()
  const rows: Map<number, string>[] = []
  let fields = 0
  let nested = 0
  let toks: Generator<Tok, void, undefined>
  const units = opts.lines ? text.split('\n').filter((l) => l.trim() !== '') : [text]
  try {
    for (const unit of units) {
      toks = tokens(unit)
      const next = (): Tok | undefined => {
        for (;;) {
          const r = toks.next()
          if (r.done) return undefined
          if (r.value.k !== 'comment') return r.value
        }
      }
      let t = next()
      const inArray = !opts.lines
      if (inArray) {
        if (t?.k !== 'open' || t.c !== '[') return null
        t = next()
        if (t?.k === 'close' && t.c === ']') return null
      }
      for (;;) {
        if (t?.k !== 'open' || t.c !== '{') return null
        const row = new Map<number, string>()
        t = next()
        if (!(t?.k === 'close' && t.c === '}')) {
          for (;;) {
            if (t?.k !== 'value' || !t.quoted) return null
            const key = stringValue(t.text)
            if (next()?.k !== 'colon') return null
            const v = next()
            if (!v) return null
            let cell: string
            if (v.k === 'value') cell = v.quoted ? stringValue(v.text) : v.text === 'null' ? '' : v.text
            else if (v.k === 'open') {
              nested++
              const inner: Tok[] = [v]
              let depth = 1
              while (depth > 0) {
                const w = next()
                if (!w) return null
                if (w.k === 'open') depth++
                else if (w.k === 'close') depth--
                inner.push(w)
              }
              cell = compact(inner)
            } else return null
            fields++
            let col = seen.get(key)
            if (col === undefined) {
              col = header.length
              header.push(key)
              seen.set(key, col)
            }
            row.set(col, cell)
            t = next()
            if (t?.k === 'comma') {
              t = next()
              continue
            }
            if (t?.k === 'close' && t.c === '}') break
            return null
          }
        }
        rows.push(row)
        if (!inArray) {
          if (next() !== undefined) return null
          break
        }
        t = next()
        if (t?.k === 'comma') {
          t = next()
          continue
        }
        if (t?.k === 'close' && t.c === ']') {
          if (next() !== undefined) return null
          break
        }
        return null
      }
    }
  } catch {
    return null
  }
  if (rows.length === 0 || (fields > 0 && nested / fields > 0.1)) return null
  return { header, rows: rows.map((r) => header.map((_h, i) => r.get(i) ?? '')) }
}
