/*
 * A document's own TeX definitions (\newcommand, \def, \DeclareMathOperator…),
 * carried from the formula that makes them into the later formulas that use
 * them. The render host draws every formula on its own and forgets what each
 * defined (resources/render/host.js), so its drawings stay cacheable and one
 * document cannot change another's; here, within one conversion, each
 * formula is instead handed the definitions it needs, in document order, as
 * part of its own source.
 *
 * Only a definition read whole is carried: a named control sequence and
 * balanced groups. One that is malformed stays the error of its own formula
 * and never becomes the error of the formulas after it.
 */

export interface TexDefinition {
  /** `\name` for a macro or delimiter, `env:name` for an environment. */
  name: string
  /** The definition as written, to be put in front of a later formula. */
  text: string
  /** The names its body refers to (so what it uses is carried with it). */
  uses: string[]
}

const DEFINER = /\\(newcommand|renewcommand|providecommand|def|let|DeclareMathOperator|newenvironment|renewenvironment|DeclarePairedDelimiter)(?![A-Za-z])/g

/** The source with its comments blanked out (same length, so offsets hold). */
function blankComments(tex: string): string {
  return tex.replace(/(^|[^\\](?:\\\\)*)(%[^\n]*)/g, (_, before: string, comment: string) => before + ' '.repeat(comment.length))
}

function skipSpaces(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++
  return i
}

/** The end of the `{…}` group at `i`, or -1 when there is none or it is never closed. */
function groupEnd(s: string, i: number): number {
  if (s[i] !== '{') return -1
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === '{') depth++
    else if (s[j] === '}' && --depth === 0) return j + 1
  }
  return -1
}

/** The end of the control sequence at `i` (`\word` or `\` and one character), or -1. */
function csEnd(s: string, i: number): number {
  if (s[i] !== '\\' || i + 1 >= s.length) return -1
  const word = /^[A-Za-z]+/.exec(s.slice(i + 1))
  return i + 1 + (word ? word[0].length : 1)
}

/** One argument: a group or a single token. */
function argEnd(s: string, i: number): number {
  if (s[i] === '{') return groupEnd(s, i)
  if (s[i] === '\\') return csEnd(s, i)
  return i < s.length && s[i] !== '}' ? i + 1 : -1
}

/** The end of an optional `[…]` at `i` (braces inside it kept whole), `i` itself when there is none. */
function optionalEnd(s: string, i: number): number {
  if (s[i] !== '[') return i
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === '{') {
      const end = groupEnd(s, j)
      if (end < 0) return -1
      j = end - 1
    } else if (s[j] === ']') return j + 1
  }
  return -1
}

/** A macro's name, `\name` or `{\name}`: the name and where it ends, or null. */
function macroName(s: string, i: number): { name: string; end: number } | null {
  if (s[i] === '\\') {
    const end = csEnd(s, i)
    return end < 0 ? null : { name: s.slice(i, end), end }
  }
  const end = groupEnd(s, i)
  if (end < 0) return null
  const m = /^\s*(\\(?:[A-Za-z]+|.))\s*$/s.exec(s.slice(i + 1, end - 1))
  return m ? { name: m[1], end } : null
}

/** The names a piece of TeX refers to: its control sequences and the environments it begins. */
export function texNames(tex: string): string[] {
  const names = new Set<string>()
  for (const m of tex.matchAll(/\\(?:begin\s*\{([^{}]+)\}|([A-Za-z]+|.))/gs)) {
    names.add(m[1] !== undefined ? `env:${m[1].trim()}` : `\\${m[2]}`)
  }
  return [...names]
}

/** Read the definition whose command (`\newcommand`…) ends at `i`; null when it is not whole. */
function readDefinition(s: string, kind: string, i: number): { name: string; end: number; body: number } | null {
  let at = skipSpaces(s, i)
  switch (kind) {
    case 'newcommand':
    case 'renewcommand':
    case 'providecommand':
    case 'DeclareMathOperator': {
      if (s[at] === '*') at = skipSpaces(s, at + 1)
      const name = macroName(s, at)
      if (!name) return null
      at = skipSpaces(s, name.end)
      const body = at
      if (kind !== 'DeclareMathOperator') {
        for (let k = 0; k < 2; k++) {
          at = optionalEnd(s, at)
          if (at < 0) return null
          at = skipSpaces(s, at)
        }
      }
      const end = groupEnd(s, at)
      return end < 0 ? null : { name: name.name, end, body }
    }
    case 'def': {
      const name = macroName(s, at)
      if (!name || s[at] !== '\\') return null
      // The parameter text runs to the body's opening brace.
      let open = name.end
      while (open < s.length && s[open] !== '{' && s[open] !== '}') open++
      const end = groupEnd(s, open)
      return end < 0 ? null : { name: name.name, end, body: name.end }
    }
    case 'let': {
      const name = macroName(s, at)
      if (!name || s[at] !== '\\') return null
      at = skipSpaces(s, name.end)
      if (s[at] === '=') at = skipSpaces(s, at + 1)
      const end = s[at] === '\\' ? csEnd(s, at) : at < s.length && !/[\s{}]/.test(s[at]) ? at + 1 : -1
      return end < 0 ? null : { name: name.name, end, body: name.end }
    }
    case 'newenvironment':
    case 'renewenvironment': {
      const nameEnd = groupEnd(s, at)
      const env = nameEnd < 0 ? null : /^\s*([A-Za-z@*]+)\s*$/.exec(s.slice(at + 1, nameEnd - 1))
      if (!env) return null
      at = skipSpaces(s, nameEnd)
      const body = at
      for (let k = 0; k < 2; k++) {
        at = optionalEnd(s, at)
        if (at < 0) return null
        at = skipSpaces(s, at)
      }
      const beginEnd = groupEnd(s, at)
      if (beginEnd < 0) return null
      const end = groupEnd(s, skipSpaces(s, beginEnd))
      return end < 0 ? null : { name: `env:${env[1]}`, end, body }
    }
    case 'DeclarePairedDelimiter': {
      const name = macroName(s, at)
      if (!name) return null
      const left = argEnd(s, skipSpaces(s, name.end))
      if (left < 0) return null
      const end = argEnd(s, skipSpaces(s, left))
      return end < 0 ? null : { name: name.name, end, body: name.end }
    }
  }
  return null
}

/** The definitions one formula makes, in the order it makes them. */
export function texDefinitions(tex: string): TexDefinition[] {
  const s = blankComments(tex)
  const out: TexDefinition[] = []
  DEFINER.lastIndex = 0
  for (let m = DEFINER.exec(s); m; m = DEFINER.exec(s)) {
    // `\\def` is a line break and the word "def", not a definition.
    if (/(^|[^\\])(\\\\)*$/.test(s.slice(0, m.index)) === false) continue
    const def = readDefinition(s, m[1], m.index + m[0].length)
    if (!def) continue
    out.push({ name: def.name, text: tex.slice(m.index, def.end), uses: texNames(s.slice(def.body, def.end)) })
    DEFINER.lastIndex = def.end
  }
  return out
}

/**
 * Each formula's source as it is to be drawn: the definitions earlier
 * formulas made that it uses (directly, or through another definition it
 * uses), in document order, then its own source. A formula that uses none
 * is drawn exactly as written, so its drawing is shared with the editor's
 * and with every other document's.
 */
export function carryDefinitions(sources: readonly string[]): string[] {
  const made: TexDefinition[] = []
  return sources.map((source) => {
    let drawn = source
    if (made.length > 0) {
      const needed = new Set(texNames(blankComments(source)))
      const take = new Set<number>()
      for (let grew = true; grew; ) {
        grew = false
        made.forEach((def, k) => {
          if (take.has(k) || !needed.has(def.name)) return
          take.add(k)
          for (const name of def.uses) needed.add(name)
          grew = true
        })
      }
      if (take.size > 0) drawn = made.filter((_, k) => take.has(k)).map((def) => def.text).join('') + source
    }
    made.push(...texDefinitions(source))
    return drawn
  })
}
