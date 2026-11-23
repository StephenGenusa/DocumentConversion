import { describe, it, expect } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib'
import { createPdfWriter } from '../../src/core/writers/pdf'
import { mergePdfs } from '../../src/core/pdf-merge'
import { linkAcrossParts, PART_LINK_BASE } from '../../src/core/pdf-part-links'
import { MAX_ROWS_PER_CHUNK } from '../../src/core/html-chunk'

/**
 * A 900-page command reference, 5,516 table rows, printed in parts: of its
 * 3,366 links to its own headings 1,159 survived, the ones whose heading
 * printed in the same part, and none of those worked, because the joined file
 * had no destinations for them to name.
 */

const table = (rows: number): string =>
  `<table><tbody>${Array.from({ length: rows }, (_, r) => `<tr><td>r${r}</td></tr>`).join('')}</tbody></table>`

interface FakeLink {
  rect: [number, number, number, number]
  uri?: string
  dest?: string
}

/** A printed part as Chromium writes one: a page per entry, each with its link annotations. */
async function printed(pages: FakeLink[][], dests: Record<string, [number, number]> = {}): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const made = pages.map((links) => {
    const page = pdf.addPage([612, 792])
    const annots = links.map((l) =>
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: l.rect,
          ...(l.uri ? { A: { Type: 'Action', S: 'URI', URI: PDFString.of(l.uri) } } : {}),
          ...(l.dest ? { Dest: l.dest } : {}),
        }),
      ),
    )
    page.node.set(PDFName.of('Annots'), pdf.context.obj(annots))
    return page
  })
  const named: Record<string, unknown> = {}
  for (const [name, [page, top]] of Object.entries(dests)) named[name] = [made[page].ref, 'XYZ', 0, top, 0]
  if (Object.keys(named).length > 0) pdf.catalog.set(PDFName.of('Dests'), pdf.context.obj(named as never))
  return Buffer.from(await pdf.save())
}

/** Stands in for Chromium: one page, with a link annotation for every part-link address in the html. */
const printPartLinks = async (html: string): Promise<Buffer> => {
  const uris = [...html.matchAll(/href="(https:\/\/part-link\.invalid\/[^"]+)"/g)].map((m) => m[1])
  return printed([uris.map((uri, i) => ({ rect: [30, 700 - i * 20, 90, 712 - i * 20], uri }))])
}

async function linksOf(bytes: Buffer): Promise<{ page: number; uri?: string; toPage?: number; top?: number }[]> {
  const doc = await PDFDocument.load(bytes)
  const pages = doc.getPages()
  const out: { page: number; uri?: string; toPage?: number; top?: number }[] = []
  pages.forEach((page, i) => {
    const annots = page.node.Annots()
    for (let k = 0; k < (annots?.size() ?? 0); k++) {
      const annot = annots!.lookup(k, PDFDict)
      const action = annot.lookupMaybe(PDFName.of('A'), PDFDict)
      const dest = annot.lookup(PDFName.of('Dest'))
      const uri = action?.lookupMaybe(PDFName.of('URI'), PDFString)?.decodeText()
      if (dest instanceof PDFArray) {
        const ref = dest.get(0) as PDFRef
        out.push({ page: i, uri, toPage: pages.findIndex((p) => p.ref === ref), top: (dest.get(3) as PDFNumber).asNumber() })
      } else out.push({ page: i, uri })
    }
  })
  return out
}

interface Bookmark {
  title: string
  toPage: number
  top: number
  count: number
  items: Bookmark[]
}

/** The bookmarks sidebar as a reader walks it: First, then Next, checking each entry's Parent and Prev on the way. */
async function outlineOf(bytes: Buffer): Promise<{ count: number; items: Bookmark[] } | undefined> {
  const doc = await PDFDocument.load(bytes)
  const pages = doc.getPages()
  const rootRef = doc.catalog.get(PDFName.of('Outlines'))
  if (!rootRef) return undefined
  const under = (parentRef: unknown, parent: PDFDict): Bookmark[] => {
    const items: Bookmark[] = []
    let prev: unknown
    let ref = parent.get(PDFName.of('First'))
    while (ref) {
      const item = doc.context.lookup(ref, PDFDict)
      expect(item.get(PDFName.of('Parent'))).toBe(parentRef)
      expect(item.get(PDFName.of('Prev'))).toBe(prev)
      const dest = item.lookup(PDFName.of('Dest'), PDFArray)
      items.push({
        title: (item.lookup(PDFName.of('Title')) as PDFHexString).decodeText(),
        toPage: pages.findIndex((p) => p.ref === dest.get(0)),
        top: (dest.get(3) as PDFNumber).asNumber(),
        count: item.lookupMaybe(PDFName.of('Count'), PDFNumber)?.asNumber() ?? 0,
        items: under(ref, item),
      })
      prev = ref
      ref = item.get(PDFName.of('Next'))
    }
    expect(parent.get(PDFName.of('Last'))).toBe(prev)
    return items
  }
  const root = doc.context.lookup(rootRef, PDFDict)
  return { count: root.lookup(PDFName.of('Count'), PDFNumber).asNumber(), items: under(rootRef, root) }
}

describe('links in a pdf printed in parts', () => {
  it('numbers each link by its target and marks the target', () => {
    const out = linkAcrossParts('<p><a href="#b-side">B</a> <a href="#b-side">again</a></p><h2>A side</h2><h3>B <em>side</em></h3><h2> </h2>')
    expect(out.html).toBe(
      `<p><a href="${PART_LINK_BASE}to/1">B</a> <a href="${PART_LINK_BASE}to/1">again</a></p><h2><a href="${PART_LINK_BASE}at/2" style="position:absolute;width:1px;height:1px" aria-hidden="true"></a>A side</h2>` +
        `<h3 id="b-side"><a href="${PART_LINK_BASE}at/1" style="position:absolute;width:1px;height:1px" aria-hidden="true"></a>B <em>side</em></h3><h2> </h2>`,
    )
    // Every heading with text is one for the bookmarks, linked to or not.
    expect(out.headings).toEqual([
      { title: 'A side', level: 2, mark: '2' },
      { title: 'B side', level: 3, mark: '1' },
    ])
  })

  it('numbers a repeated heading as the whole document does, not as its part would', () => {
    const out = linkAcrossParts('<p><a href="#notes-1">second</a></p><h2>Notes</h2><h2>Notes</h2>').html
    expect(out).toMatch(/<h2><a href="[^"]+at\/2"[^>]*><\/a>Notes<\/h2><h2 id="notes-1"><a href="[^"]+at\/1"/)
  })

  it('links a note and its reference both ways, the marker beside a target that is itself a link', () => {
    const out = linkAcrossParts('<p>Text<sup data-fn="a">1</sup></p><ol><li data-fn="a">Note</li></ol>').html
    expect(out).toContain(`<a href="${PART_LINK_BASE}at/2" style="position:absolute;width:1px;height:1px" aria-hidden="true"></a><a href="${PART_LINK_BASE}to/1" id="fnref-a">1</a>`)
    expect(out).toMatch(/<li id="fn-a"><a href="[^"]+at\/1"[^>]*><\/a>Note <a href="[^"]+to\/2" class="fnback"/)
  })

  it('leaves a document with no links to itself and no headings alone', () => {
    const html = '<p><a href="https://example.com/#x">out</a></p><p>One</p>'
    expect(linkAcrossParts(html)).toEqual({ html, headings: [] })
  })

  it('keeps a link whose heading prints in another part, and points it there', async () => {
    const rendered: string[] = []
    const render = async (html: string): Promise<Buffer> => {
      rendered.push(html)
      return printPartLinks(html)
    }
    const html =
      '<ul><li><a href="#first">First</a></li><li><a href="#last">Last</a></li></ul>' +
      `<h2>First</h2>${table(MAX_ROWS_PER_CHUNK)}${table(MAX_ROWS_PER_CHUNK)}<h2>Last</h2>`
    const out = await createPdfWriter(render)({ html })
    expect(rendered.length).toBe(2)
    expect(rendered[0]).not.toContain('Last</h2>')
    const links = await linksOf(out)
    // Both contents entries are links, to their headings' pages; the markers are gone.
    expect(links).toEqual([
      { page: 0, uri: undefined, toPage: 0, top: 672 },
      { page: 0, uri: undefined, toPage: 1, top: 712 },
    ])
  })

  it('writes the bookmarks of a document printed in parts, nested by heading level', async () => {
    const html =
      `<h1>Guide é</h1><h2>First</h2><h3>Deep</h3>${table(MAX_ROWS_PER_CHUNK)}${table(MAX_ROWS_PER_CHUNK)}` +
      '<h2>Second</h2><h1>Appendix</h1><h3>Skipped a level</h3>'
    const out = await createPdfWriter(printPartLinks)({ html })
    expect(await linksOf(out)).toEqual([])
    expect(await outlineOf(out)).toEqual({
      count: 6,
      items: [
        {
          title: 'Guide é', toPage: 0, top: 712, count: 3,
          items: [
            { title: 'First', toPage: 0, top: 692, count: 1, items: [{ title: 'Deep', toPage: 0, top: 672, count: 0, items: [] }] },
            { title: 'Second', toPage: 1, top: 712, count: 0, items: [] },
          ],
        },
        {
          title: 'Appendix', toPage: 1, top: 692, count: 1,
          items: [{ title: 'Skipped a level', toPage: 1, top: 672, count: 0, items: [] }],
        },
      ],
    })
  })

  it('joins the links of a document that was linked for parts and then printed in one', async () => {
    // More rows than one part takes, but in a nested table, which is never cut.
    const html = `<p><a href="#only">Only</a></p><h2>Only</h2><table><tbody><tr><td>${table(MAX_ROWS_PER_CHUNK + 1)}</td></tr></tbody></table>`
    const out = await createPdfWriter(printPartLinks)({ html })
    expect(await linksOf(out)).toEqual([{ page: 0, uri: undefined, toPage: 0, top: 692 }])
  })

  it('removes a link whose target never printed rather than leave its address', async () => {
    const part = await printed([[{ rect: [30, 700, 90, 712], uri: `${PART_LINK_BASE}to/7` }, { rect: [30, 600, 90, 612], uri: 'https://example.com/' }]])
    const out = await mergePdfs([{ bytes: part }, { bytes: part }], { partLinks: true })
    expect((await linksOf(out)).map((l) => l.uri)).toEqual(['https://example.com/', 'https://example.com/'])
  })
})

describe('merging pdfs whose links name their destinations', () => {
  it('points each link at the place its own document named, on the merged page', async () => {
    const a = await printed([[{ rect: [30, 700, 90, 712], dest: 'sources' }], []], { sources: [1, 500] })
    const b = await printed([[], [{ rect: [30, 700, 90, 712], dest: 'sources' }]], { sources: [0, 300] })
    const out = await mergePdfs([{ bytes: a }, { bytes: b }])
    expect(await linksOf(out)).toEqual([
      { page: 0, uri: undefined, toPage: 1, top: 500 },
      { page: 3, uri: undefined, toPage: 2, top: 300 },
    ])
  })
})
