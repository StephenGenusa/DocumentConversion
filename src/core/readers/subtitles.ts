import { sanitizeToHub } from '../allowlist'
import { escapeHtml } from '../shell'
import { decodeTextBytes } from './txt'
import type { HubDocument, ReadContext, SourceInput } from '../types'

/**
 * Subtitles and transcripts: WebVTT and SRT (spec D8).
 *
 * Read for a person, not for a player: positioning, styling and cue ids are
 * dropped, and what is left is who said what, and when. A WebVTT voice tag
 * (`<v Name>`) names the speaker, which is how Teams marks meeting
 * transcripts, and Teams splits one sentence over many cues, so a speaker's
 * consecutive cues become one paragraph that keeps the first cue's time.
 *
 * The times are a read-time choice (`transcriptTimestamps`, on unless turned
 * off). Nothing in the hub would let a writer find and strip them later.
 */

interface Cue {
  start: number
  end: number
  speaker?: string
  /** Hub HTML: text, with only <b>, <i> and <u> kept. */
  html: string
}

/** A gap this long between cues starts a new paragraph when times are off. */
const PARAGRAPH_GAP_SECONDS = 3

const TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/

function seconds(stamp: string): number {
  const parts = stamp.replace(',', '.').split(':').map(Number)
  return parts.reduce((total, p) => total * 60 + p, 0)
}

/** hh:mm:ss, milliseconds dropped. */
function clock(total: number): string {
  const s = Math.floor(total)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

const KEPT_TAGS = new Set(['b', 'i', 'u'])

/**
 * A cue's text as hub HTML, and the speaker its first voice tag names. Every
 * tag but <b>, <i> and <u> is dropped and its text kept: <c.class>, <ruby>,
 * <lang>, timestamp tags, SRT's <font>, and anything that only looks like a
 * tag. The result is sanitised, so an unclosed <b> cannot run on.
 */
function cueText(lines: string[]): { html: string; speaker?: string } {
  let speaker: string | undefined
  const out: string[] = []
  const text = lines.join(' ')
  for (const m of text.matchAll(/<(\/?)([^\s>.\/]*)([^>]*)>|[^<]+|</g)) {
    const [whole, close, tag, rest] = m
    if (!whole.startsWith('<') || whole === '<') {
      out.push(escapeHtml(decodeEntities(whole)))
      continue
    }
    const name = tag.toLowerCase()
    if (name === 'v' && !close) {
      // `<v Name>` or `<v.class Name>`: the name follows the first space.
      const who = decodeEntities(rest.replace(/^[^\s]*\s*/, '').trim())
      if (speaker === undefined && who) speaker = who
    } else if (KEPT_TAGS.has(name)) {
      out.push(`<${close}${name}>`)
    }
  }
  const html = sanitizeToHub(out.join('').replace(/\s+/g, ' ').trim())
  return speaker === undefined ? { html } : { html, speaker }
}

function parseCues(text: string): Cue[] {
  const cues: Cue[] = []
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    if (lines.length === 0) continue
    // The header, comments and styling are not cues.
    if (/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue
    // An optional cue id (or SRT's index) comes before the timing line.
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0 || at > 1) continue
    const timing = TIMING.exec(lines[at].trim())
    if (!timing) continue
    const { html, speaker } = cueText(lines.slice(at + 1))
    if (html === '') continue
    cues.push({ start: seconds(timing[1]), end: seconds(timing[2]), html, ...(speaker !== undefined ? { speaker } : {}) })
  }
  return cues
}

/** Paragraphs: speaker turns when any cue names a speaker, else cues. */
function paragraphs(cues: Cue[], timestamps: boolean): string[] {
  const out: string[] = []
  const hasSpeakers = cues.some((c) => c.speaker !== undefined)
  if (hasSpeakers) {
    for (let i = 0; i < cues.length; ) {
      const first = cues[i]
      const parts: string[] = []
      while (i < cues.length && cues[i].speaker === first.speaker) parts.push(cues[i++].html)
      const who = first.speaker !== undefined ? `<strong>${escapeHtml(first.speaker)}</strong> ` : ''
      const when = timestamps ? `${clock(first.start)} ` : ''
      out.push(`<p>${who}${when}${parts.join(' ')}</p>`)
    }
    return out
  }
  if (timestamps) return cues.map((c) => `<p>${clock(c.start)} ${c.html}</p>`)
  // No speakers and no times: one line per cue would read as a list, so cues
  // flow together, with a new paragraph where the speech pauses.
  let current: string[] = []
  let lastEnd = -Infinity
  for (const c of cues) {
    if (current.length > 0 && c.start - lastEnd >= PARAGRAPH_GAP_SECONDS) {
      out.push(`<p>${current.join(' ')}</p>`)
      current = []
    }
    current.push(c.html)
    lastEnd = c.end
  }
  if (current.length > 0) out.push(`<p>${current.join(' ')}</p>`)
  return out
}

export async function readSubtitles(src: SourceInput, ctx?: ReadContext): Promise<HubDocument> {
  const name = (src.filename ?? 'transcript.vtt').split(/[\\/]/).pop() ?? 'transcript.vtt'
  const cues = parseCues(decodeTextBytes(src.bytes))
  const body = paragraphs(cues, ctx?.transcriptTimestamps !== false)
  return { html: [`<h1>${escapeHtml(name)}</h1>`, ...body].join('\n'), title: name }
}
