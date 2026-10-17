import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createConverter } from '../../src/core/convert'
import { readingOrder, type DrawingLabel } from '../../src/core/metafile'
import { allowedTargets } from '../../src/core/target-validity'

// Owner, 2026-10-17: an EMF or WMF converts to txt and Markdown, as its labels in reading order.

const corpus = (name: string): Buffer => readFileSync(join(__dirname, '../corpus', name))
const conv = createConverter(async () => Buffer.from('%PDF'))
const label = (text: string, l: number, t: number, w: number, h = 20): DrawingLabel => ({ text, bounds: { l, t, r: l + w, b: t + h } })

describe('readingOrder', () => {
  it('reads top to bottom, then left to right, whatever order they were drawn in', () => {
    const labels = [label('Entrance', 150, 210, 60), label('Desk', 238, 160, 40), label('Media', 45, 158, 50), label('Periodicals', 205, 58, 90), label('Fiction', 45, 58, 60)]
    expect(readingOrder(labels)).toEqual(['Fiction', 'Periodicals', 'Media', 'Desk', 'Entrance'])
  })

  it('puts labels a little off one baseline on one line', () => {
    expect(readingOrder([label('Right', 200, 104, 50), label('Left', 10, 100, 40)])).toEqual(['Left', 'Right'])
  })

  it('joins a phrase drawn a word or a few letters at a time', () => {
    expect(readingOrder([label('Room', 66, 0, 40), label('Reading', 0, 0, 60)])).toEqual(['Reading Room'])
    expect(readingOrder([label('Shel', 0, 0, 36), label('ving', 36.5, 0, 34)])).toEqual(['Shelving'])
  })

  it('says a run drawn again over itself (a shadow) once', () => {
    expect(readingOrder([label('Title', 0, 0, 50), label('Title', 1.5, 1.5, 50)])).toEqual(['Title'])
  })

  it('keeps labels far apart on one line as labels of their own', () => {
    expect(readingOrder([label('North', 0, 0, 50), label('South', 300, 0, 50)])).toEqual(['North', 'South'])
  })

  it('a tall label (turned on its side) does not pull lines together: it is read at its middle', () => {
    const labels = [label('Amount', 0, 0, 20, 120), label('Top', 40, 0, 30), label('Bottom', 40, 100, 50)]
    expect(readingOrder(labels)).toEqual(['Top', 'Amount', 'Bottom'])
  })
})

describe('EMF and WMF to txt and Markdown', () => {
  it('offers txt and md for a drawing (and still not for a raster picture)', () => {
    expect(allowedTargets([{ format: 'metafile' }])).toEqual(expect.arrayContaining(['txt', 'md']))
    expect(allowedTargets([{ format: 'image', imageMode: 'embed' }])).not.toContain('txt')
  })

  it('emf -> txt gives the floor plan labels, one a line, in reading order', async () => {
    const r = await conv.convert({ bytes: corpus('reading-room-floor-plan.emf'), filename: 'plan.emf' }, 'metafile', 'txt')
    expect(r.parts[0].bytes.toString('utf8').trim().split(/\n+/)).toEqual(['Fiction', 'Periodicals', 'Media', 'Desk', 'Entrance'])
  })

  it('wmf -> txt gives its label', async () => {
    const r = await conv.convert({ bytes: corpus('reading-room-shelf-label.wmf'), filename: 'label.wmf' }, 'metafile', 'txt')
    expect(r.parts[0].bytes.toString('utf8').trim()).toBe('Periodicals')
  })

  it('emf -> md gives the drawing as an SVG picture, then its labels as a list', async () => {
    const r = await conv.convert({ bytes: corpus('reading-room-floor-plan.emf'), filename: 'plan.emf' }, 'metafile', 'md')
    const md = r.parts[0].bytes.toString('utf8')
    expect(md).toMatch(/!\[[^\]]*\]\(data:image\/svg\+xml;base64,/)
    expect(md).not.toMatch(/x-emf/)
    const items = [...md.matchAll(/^[-*]\s+(.+)$/gm)].map((m) => m[1])
    expect(items).toEqual(['Fiction', 'Periodicals', 'Media', 'Desk', 'Entrance'])
    expect(md.indexOf('data:image/svg+xml')).toBeLessThan(md.search(/^[-*]\s+Fiction$/m))
  })

  it('the alt text says the labels in reading order too', async () => {
    const hub = await conv.read({ bytes: corpus('reading-room-floor-plan.emf'), filename: 'plan.emf' }, 'metafile')
    expect(hub.html).toContain('alt="Fiction Periodicals Media Desk Entrance"')
  })

  it('a document that is more than the drawing keeps the drawing as its alt text', async () => {
    const hub = await conv.read({ bytes: corpus('reading-room-floor-plan.emf'), filename: 'plan.emf' }, 'metafile')
    const r = await conv.write({ ...hub, html: `<h1>Plan</h1>${hub.html}` }, 'txt')
    const text = r.parts[0].bytes.toString('utf8')
    expect(text).toContain('Fiction Periodicals Media Desk Entrance')
    expect(text).not.toMatch(/^Fiction$/m)
  })
})
