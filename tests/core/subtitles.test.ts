import { describe, it, expect } from 'vitest'
import { readSubtitles } from '../../src/core/readers/subtitles'
import { detect } from '../../src/core/detect'
import { cliReadOptions, parseArgs, checkFlagScope } from '../../src/cli/args'
import type { ReadContext } from '../../src/core/types'

const read = (text: string, filename = 'meeting.vtt', ctx?: ReadContext) =>
  readSubtitles({ bytes: Buffer.from(text, 'utf8'), filename }, ctx)

// The shape Teams writes: a cue id, a voice tag per cue, sentences split
// across cues. Names are invented.
const TEAMS = [
  'WEBVTT',
  '',
  '6d1c2f0e-0000-4000-8000-000000000001/12-0',
  '00:00:01.250 --> 00:00:03.900',
  '<v Petra Ferrow>Good morning, everyone.</v>',
  '',
  '6d1c2f0e-0000-4000-8000-000000000001/13-0',
  '00:00:04.000 --> 00:00:06.500',
  '<v Petra Ferrow>Let us start with the',
  'release dates.</v>',
  '',
  '6d1c2f0e-0000-4000-8000-000000000002/1-0',
  '00:01:23.400 --> 00:01:25.000',
  '<v Juno Halloway>Thanks, Petra.</v>',
  '',
  '6d1c2f0e-0000-4000-8000-000000000001/14-0',
  '01:02:03.999 --> 01:02:05.000',
  '<v Petra Ferrow>One more thing.</v>',
  '',
].join('\n')

describe('transcripts (WebVTT voice tags)', () => {
  it('gives one paragraph per turn, merging a speaker’s consecutive cues and keeping the first time', async () => {
    const hub = await read(TEAMS)
    expect(hub.title).toBe('meeting.vtt')
    const paras = hub.html.match(/<p>.*?<\/p>/g)
    expect(paras).toEqual([
      '<p><strong>Petra Ferrow</strong> 00:00:01 Good morning, everyone. Let us start with the release dates.</p>',
      '<p><strong>Juno Halloway</strong> 00:01:23 Thanks, Petra.</p>',
      '<p><strong>Petra Ferrow</strong> 01:02:03 One more thing.</p>',
    ])
  })

  it('leaves the times out when asked', async () => {
    const hub = await read(TEAMS, 'meeting.vtt', { transcriptTimestamps: false })
    expect(hub.html).toContain('<p><strong>Juno Halloway</strong> Thanks, Petra.</p>')
    expect(hub.html).not.toMatch(/\d\d:\d\d:\d\d/)
  })

  it('reads a voice tag with a class and no closing tag', async () => {
    const hub = await read('WEBVTT\n\n00:05.000 --> 00:06.000\n<v.loud Nils Ashcombe>Over here\n')
    expect(hub.html).toContain('<p><strong>Nils Ashcombe</strong> 00:00:05 Over here</p>')
  })
})

describe('subtitles without speakers', () => {
  const SRT = [
    '1',
    '00:00:01,000 --> 00:00:02,000',
    'The <i>first</i> line',
    '',
    '2',
    '00:00:02,500 --> 00:00:04,000',
    'and the <b>second</b>.',
    '',
    '3',
    '00:00:09,000 --> 00:00:10,000',
    '<font color="#ffffff">After a pause</font>',
    '',
  ].join('\r\n')

  it('gives one paragraph per cue with its time, keeping <i> and <b> and dropping other tags', async () => {
    const hub = await read(SRT, 'film.srt')
    expect(hub.html.match(/<p>.*?<\/p>/g)).toEqual([
      '<p>00:00:01 The <i>first</i> line</p>',
      '<p>00:00:02 and the <b>second</b>.</p>',
      '<p>00:00:09 After a pause</p>',
    ])
  })

  it('without times, joins cues into paragraphs and breaks at a gap of 3 s or more', async () => {
    const hub = await read(SRT, 'film.srt', { transcriptTimestamps: false })
    expect(hub.html.match(/<p>.*?<\/p>/g)).toEqual([
      '<p>The <i>first</i> line and the <b>second</b>.</p>',
      '<p>After a pause</p>',
    ])
  })

  it('skips NOTE, STYLE and REGION blocks and the header’s metadata', async () => {
    const vtt = [
      'WEBVTT - with notes',
      'Kind: captions',
      '',
      'STYLE',
      '::cue { color: yellow }',
      '',
      'REGION',
      'id:fred width:40%',
      '',
      'NOTE this is a comment',
      'that runs on',
      '',
      '00:00:01.000 --> 00:00:02.000 align:start position:10%',
      'Hello <c.yellow>there</c> <ruby>漢<rt>kan</rt></ruby> <00:00:01.500>now &amp; then',
      '',
    ].join('\n')
    const hub = await read(vtt)
    expect(hub.html.match(/<p>.*?<\/p>/g)).toEqual(['<p>00:00:01 Hello there 漢kan now &amp; then</p>'])
    expect(hub.html).not.toMatch(/yellow|fred|comment|captions/)
  })

  it('escapes text that only looks like markup', async () => {
    const hub = await read('WEBVTT\n\n00:01.000 --> 00:02.000\n1 &lt; 2 &amp;&amp; <script>alert(1)</script>\n')
    expect(hub.html).toContain('1 &lt; 2 &amp;&amp; alert(1)')
    expect(hub.html).not.toContain('<script')
  })

  it('reads a Windows-1252 .srt', async () => {
    const bytes = Buffer.concat([Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nCaf'), Buffer.from([0xe9]), Buffer.from('\r\n')])
    const hub = await readSubtitles({ bytes, filename: 'old.srt' })
    expect(hub.html).toContain('Café')
  })
})

describe('detecting subtitles', () => {
  it('by extension', () => {
    for (const name of ['a.vtt', 'a.srt', 'A.VTT']) {
      const d = detect(Buffer.from('x'), name)
      expect(d.kind === 'ok' && d.format, name).toBe('subtitles')
    }
  })
  it('by the WEBVTT header when there is no extension', () => {
    const d = detect(Buffer.from('\ufeffWEBVTT\n\n00:01.000 --> 00:02.000\nhi\n'), 'transcript')
    expect(d.kind === 'ok' && d.format).toBe('subtitles')
    const prose = detect(Buffer.from('WEBVTTX is not a header\n'), 'notes')
    expect(prose.kind === 'ok' && prose.format).toBe('txt')
  })
})

describe('--no-timestamps', () => {
  it('turns times off for every input', () => {
    const r = parseArgs(['convert', 'a.vtt', '--to', 'md', '--no-timestamps'].slice(1))
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(cliReadOptions(r.req)).toEqual({ transcriptTimestamps: false })
  })
  it('is a usage error when no input is a transcript', () => {
    expect(checkFlagScope(['--no-timestamps'], 'md', ['docx'])).toMatch(/--no-timestamps applies only to subtitles input/)
    expect(checkFlagScope(['--no-timestamps'], 'md', ['subtitles'])).toBeNull()
  })
})
