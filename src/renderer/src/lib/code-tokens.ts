import { hljs } from './code-grammars'

/*
 * A code block's colored stretches, kept up to date as it is edited without
 * highlighting the whole block again on every key.
 *
 * highlight.js reads a text from its start: what a line means can depend on
 * any line before it (a docstring or block comment opened 300 lines up). It
 * has no way to carry its state from one call to the next, so the block is
 * colored from a *restart point*: a line start where highlight.js is between
 * tokens, so coloring from there gives what coloring from the top would.
 * After an edit, the block is colored again from the last restart point
 * before it, until the coloring meets one of the old restart points after
 * the edit; from there on the old colors still hold, shifted by what the
 * edit added or took away. An edit that opens a string with no end in sight
 * changes everything after it, and the coloring goes only as far as it is
 * needed (what is on screen and the margin past it); the rest is colored
 * when it scrolls into view.
 *
 * Which line starts are restart points is judged per language (RESTART).
 */

/** A colored stretch, as [from, to, highlight.js classes] offsets into the text. */
export type Token = readonly [from: number, to: number, cls: string]

/**
 * How a language's restart points are found. A line start outside every
 * token is always the first condition; then
 * - `line`: that is enough. Checked against highlight.js coloring the whole
 *   text, at every such line of real files (this repository and its
 *   dependencies: Python, JavaScript, TypeScript, CSS, SCSS, Markdown, JSON,
 *   YAML, Bash, HTML) and of invented samples written to cross lines inside
 *   brackets, initializers, here-documents and raw strings (the rest of the
 *   `line` list below): the colors after it matched every time;
 * - `column0`: the line must also start with something other than white
 *   space. Swift (parameters across lines) and TOML/INI (an array across
 *   lines) need it, and so does every language not checked: their grammars
 *   may keep state between tokens across a line break, and a top-level line
 *   is the safer guess;
 * - `statement`: column 0, and the line before is blank, ends a statement
 *   or block (`;`, `{`, `}`), or is a preprocessor line or comment. C++ and
 *   Objective-C keep state across a template's or class header's lines.
 */
export type Restart = 'line' | 'column0' | 'statement'

const RESTART: Record<string, Restart> = Object.fromEntries([
  ...['python', 'javascript', 'typescript', 'css', 'scss', 'markdown', 'json', 'yaml', 'bash', 'xml'].map((l) => [l, 'line'] as const),
  ...['java', 'csharp', 'c', 'go', 'rust', 'kotlin', 'php', 'ruby', 'sql', 'powershell', 'lua', 'perl', 'r', 'makefile', 'diff', 'dockerfile', 'nginx', 'graphql'].map(
    (l) => [l, 'line'] as const,
  ),
  ['cpp', 'statement'],
  ['objectivec', 'statement'],
])

export function restartRule(language: string): Restart {
  return RESTART[language] ?? 'column0'
}

/** The colors of a text so far: `text[0, upTo)` is colored. */
export interface Colors {
  readonly language: string
  readonly text: string
  /** The colored stretches before `upTo`, in order. */
  readonly tokens: readonly Token[]
  /** Restart points before or at `upTo`, in order; 0 is always one. */
  readonly restarts: readonly number[]
  /** How far the text is colored: usually a restart point; the text's end once it is all colored. */
  readonly upTo: number
}

/** A text not yet colored. */
export function uncolored(language: string, text: string): Colors {
  return { language, text, tokens: [], restarts: [0], upTo: 0 }
}

/**
 * How far past what is needed one go colors, looking for a restart point to
 * stop at; doubled until it finds one. Small: after a key the next line is
 * usually where the old colors hold again.
 */
const CHUNK = 256

const ENTITY = /&(?:amp|lt|gt|quot|#x27);/g

function isRestart(text: string, at: number, rule: Restart): boolean {
  if (rule === 'line') return true
  const c = text.charCodeAt(at)
  // Not white space (space, tab, CR, LF, form feed).
  if (c === 32 || c === 9 || c === 13 || c === 10 || c === 12) return false
  if (rule === 'column0') return true
  const prev = text.slice(text.lastIndexOf('\n', at - 2) + 1, at - 1).trim()
  return prev === '' || /[;{}]$/.test(prev) || /^(#|\/\/|\/\*|\*)/.test(prev)
}

/** Color `text[from, to)`: its stretches and the restart points inside it (after `from`), as offsets into `text`. */
function scan(text: string, from: number, to: number, language: string, rule: Restart): { tokens: [number, number, string][]; restarts: number[] } {
  const { value } = hljs.highlight(text.slice(from, to), { language, ignoreIllegals: true })
  const tokens: [number, number, string][] = []
  const restarts: number[] = []
  const stack: string[] = []
  let at = from
  for (const m of value.matchAll(/<span class="([^"]*)">|<\/span>|[^<]+/g)) {
    if (m[1] !== undefined) stack.push(m[1])
    else if (m[0] === '</span>') stack.pop()
    else {
      // One character for each entity, so the offsets are the text's.
      const piece = m[0].replace(ENTITY, '.')
      if (stack.length) {
        const cls = stack.join(' ')
        const last = tokens[tokens.length - 1]
        if (last && last[1] === at && last[2] === cls) last[1] = at + piece.length
        else tokens.push([at, at + piece.length, cls])
      } else {
        for (let i = piece.indexOf('\n'); i !== -1; i = piece.indexOf('\n', i + 1)) {
          const p = at + i + 1
          if (p < to && isRestart(text, p, rule)) restarts.push(p)
        }
      }
      at += piece.length
    }
  }
  return { tokens, restarts }
}

interface Run {
  tokens: Token[]
  /** Restart points after `from`, up to and with `end` when it is one. */
  restarts: number[]
  end: number
  /** Whether it stopped where `meets` said the old colors hold again. */
  met: boolean
}

/**
 * Color `text` from the restart point `from`, a chunk at a time. With
 * `meets`, stops at the first restart point at or past `after` that it
 * accepts. Otherwise, or if there is none by `need`, stops past `need`: at a
 * restart point if there is one, else at a line end (a string or comment left
 * open runs on with no restart point in it; coloring on from there starts
 * again from the last restart point before it).
 */
function colorFrom(language: string, text: string, from: number, need: number, meets?: { after: number; at: (at: number) => boolean }): Run {
  const rule = restartRule(language)
  for (let size = CHUNK; ; size *= 2) {
    // Looking for where the old colors hold again starts small; else it goes past what is needed.
    const goal = Math.max(meets ? meets.after : need, from) + size
    // To the end of the line the goal is on, and one more line, so there is a restart point to stop at.
    let to = text.length
    if (goal < text.length) {
      const nl = text.indexOf('\n', goal)
      const next = nl < 0 ? -1 : text.indexOf('\n', nl + 1)
      to = next < 0 ? text.length : next + 1
    }
    const { tokens, restarts } = scan(text, from, to, language, rule)
    const cut = (end: number, met: boolean): Run => ({
      tokens: tokens.filter((t) => t[0] < end),
      restarts: restarts.filter((r) => r <= end),
      end,
      met,
    })
    if (meets) {
      const r = restarts.find((r) => r >= meets.after && meets.at(r))
      if (r !== undefined) return cut(r, true)
    }
    if (to === text.length) return { tokens, restarts, end: text.length, met: false }
    if (to < need) continue
    const last = restarts[restarts.length - 1]
    if (last !== undefined && last >= need) return cut(last, false)
    return { tokens, restarts, end: to, met: false }
  }
}

/** The index of the first item at or after `at`, by `of` (items in order). */
function firstAt<T>(items: readonly T[], at: number, of: (item: T) => number): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (of(items[mid]) < at) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Color at least `text[0, need)`. */
export function colorTo(c: Colors, need: number): Colors {
  const goal = Math.min(need, c.text.length)
  if (c.upTo >= goal) return c
  // On from the last restart point: where the colors reach, or before it.
  const i = c.restarts.length - 1
  const from = c.restarts[i]
  const run = colorFrom(c.language, c.text, from, goal)
  return {
    ...c,
    tokens: [...c.tokens.slice(0, firstAt(c.tokens, from, (t) => t[0])), ...run.tokens],
    restarts: [...c.restarts, ...run.restarts],
    upTo: run.end,
  }
}

/**
 * The colors after the text changed to `text`: colored again from the last
 * restart point before the change until the old colors hold again (or, when
 * they never do, as far as `need`). Then colored on to `need`.
 */
export function recolorText(c: Colors, text: string, need: number): Colors {
  const old = c.text
  if (old === text) return colorTo(c, need)
  const short = Math.min(old.length, text.length)
  let a = 0
  while (a < short && old.charCodeAt(a) === text.charCodeAt(a)) a++
  let s = 0
  while (s < short - a && old.charCodeAt(old.length - 1 - s) === text.charCodeAt(text.length - 1 - s)) s++
  const delta = text.length - old.length
  const oldEnd = old.length - s
  const newEnd = text.length - s
  // A change past where the colors reach leaves them as they are.
  if (c.upTo < old.length && a >= c.upTo) return colorTo({ ...c, text }, need)
  // The last restart point before the change: what comes before it is unchanged.
  const i = Math.max(0, firstAt(c.restarts, a, (r) => r) - 1)
  const from = c.restarts[i]
  const kept = c.tokens.slice(0, firstAt(c.tokens, from, (t) => t[0]))
  const keptRestarts = c.restarts.slice(0, i + 1)
  // An old restart point past the change, as it stands in the new text.
  const at = (r: number): boolean => {
    const o = r - delta
    if (o < oldEnd || o > c.upTo) return false
    const k = firstAt(c.restarts, o, (x) => x)
    return c.restarts[k] === o
  }
  const run = colorFrom(c.language, text, from, Math.min(need, text.length), { after: newEnd, at })
  if (run.met) {
    const o = run.end - delta
    const after = c.tokens.slice(firstAt(c.tokens, o, (t) => t[0])).map(([f, t, cls]): Token => [f + delta, t + delta, cls])
    const restartsAfter = c.restarts.slice(firstAt(c.restarts, o, (r) => r) + 1).map((r) => r + delta)
    return colorTo(
      {
        language: c.language,
        text,
        tokens: [...kept, ...run.tokens, ...after],
        restarts: [...keptRestarts, ...run.restarts, ...restartsAfter],
        upTo: c.upTo === old.length ? text.length : c.upTo + delta,
      },
      need,
    )
  }
  return { language: c.language, text, tokens: [...kept, ...run.tokens], restarts: [...keptRestarts, ...run.restarts], upTo: run.end }
}

/** The stretches that overlap `[from, to)`, cut to it. */
export function tokensIn(c: Colors, from: number, to: number): Token[] {
  const out: Token[] = []
  // A stretch starting before `from` may reach into it: start a little earlier.
  for (let i = Math.max(0, firstAt(c.tokens, from, (t) => t[0]) - 1); i < c.tokens.length; i++) {
    const [f, t, cls] = c.tokens[i]
    if (f >= to) break
    if (t <= from) continue
    out.push([Math.max(f, from), Math.min(t, to), cls])
  }
  return out
}
