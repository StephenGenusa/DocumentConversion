/**
 * Two defects seen in a saved SharePoint page (synthetic fixture:
 * "branch-directory.html", tests/corpus/).
 *
 * 1. Screen-reader-only spans were concatenated onto the visible label with no
 *    separator, so the document read "Team DocumentsCurrently selected",
 *    "BrowseTab 1 of 3.", "ItemsList Tools group. Tab 2 of 3.".
 *    Same silent-gluing class as StageOwner and ODF's swallowed <text:s>.
 *
 * 2. All 17 <img> had root-relative, relative or protocol-relative src values
 *    that can never resolve from a standalone local file, so page one
 *    rendered as a row of broken-image icons followed by broken placeholders
 *    with alt text.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readHtml } from '../../src/core/readers/html'

const CORPUS = join(__dirname, '../corpus')
const src = (s: string) => ({ bytes: Buffer.from(s, 'utf8') })
const page = (body: string) => src(`<html><body>${body}</body></html>`)

describe('readHtml hidden content', () => {
  it('drops a screen-reader-only span instead of gluing it to the visible label', async () => {
    const doc = await readHtml(page('<p><span>Browse</span><span class="ms-cui-hidden">Tab 1 of 3.</span></p>'))
    expect(doc.html).toContain('Browse')
    expect(doc.html).not.toContain('Tab 1 of 3.')
  })

  it('recognises the common visually-hidden class idioms', async () => {
    for (const cls of ['sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text', 'ms-hidden']) {
      const doc = await readHtml(page(`<p>Visible<span class="${cls}">Furniture</span></p>`))
      expect(doc.html, cls).toContain('Visible')
      expect(doc.html, cls).not.toContain('Furniture')
    }
  })

  it('recognises the 1px clip-rect visually-hidden idiom written inline', async () => {
    const style = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(1px,1px,1px,1px)'
    const doc = await readHtml(page(`<p>Visible<span style="${style}">Furniture</span></p>`))
    expect(doc.html).toContain('Visible')
    expect(doc.html).not.toContain('Furniture')
  })

  it('drops inline display:none and visibility:hidden chrome', async () => {
    const doc = await readHtml(
      page('<p>Kept</p><div style="display:none"><a href="/x">Turn on more accessible mode</a></div><span style="visibility: hidden">Ghost</span>'),
    )
    expect(doc.html).toContain('Kept')
    expect(doc.html).not.toContain('accessible mode')
    expect(doc.html).not.toContain('Ghost')
  })

  it('drops the hidden attribute and aria-hidden subtrees', async () => {
    const doc = await readHtml(page('<p>Kept</p><div hidden><p>Stub</p></div><ul aria-hidden="true"><li>Flyout</li></ul>'))
    expect(doc.html).toContain('Kept')
    expect(doc.html).not.toContain('Stub')
    expect(doc.html).not.toContain('Flyout')
  })

  it('keeps a collapsed section that carries real document content', async () => {
    const doc = await readHtml(
      page('<div style="display:none"><h2>Answer</h2><p>First para of the answer.</p><p>Second para.</p></div>'),
    )
    expect(doc.html).toContain('Answer')
    expect(doc.html).toContain('First para of the answer.')
  })

  it('keeps a hidden table, which is content whoever it was hidden from', async () => {
    const doc = await readHtml(page('<table style="display:none"><tr><td>Woodall</td><td>Dallas</td></tr></table>'))
    expect(doc.html).toContain('Woodall')
  })

  it('does not drop a class that merely contains the word hidden', async () => {
    const doc = await readHtml(page('<div class="ms-dialogHidden"><p>Real body text lives here.</p></div>'))
    expect(doc.html).toContain('Real body text lives here.')
  })
})

describe('readHtml unresolvable images', () => {
  const img = (attrs: string) => page(`<p><img ${attrs} /></p>`)

  it('replaces a root-relative image with its alt text', async () => {
    const doc = await readHtml(img('src="/_layouts/15/images/spcommon.png?rev=43" alt="Share"'))
    expect(doc.html).not.toContain('<img')
    expect(doc.html).toContain('Share')
  })

  it('drops a root-relative image that has no alt text', async () => {
    const doc = await readHtml(img('src="/_layouts/15/images/favicon.ico?rev=40"'))
    expect(doc.html).not.toContain('<img')
    expect(doc.html).not.toContain('favicon')
  })

  it('replaces a relative image, which has no base to resolve against', async () => {
    const doc = await readHtml(img('src="Map1_files/image001.png" alt="Floor plan"'))
    expect(doc.html).not.toContain('<img')
    expect(doc.html).toContain('Floor plan')
  })

  it('replaces protocol-relative and absolute filesystem paths', async () => {
    for (const s of ['//cdn.example.com/a.png', 'C:\\pics\\a.png', 'file:///pics/a.png']) {
      const doc = await readHtml(img(`src="${s}" alt="Pic"`))
      expect(doc.html, s).not.toContain('<img')
    }
  })

  it('drops an icon whose alt only repeats the label beside it', async () => {
    const doc = await readHtml(
      page('<a href="/x"><span><img src="/_layouts/15/images/spcommon.png" alt="Share" /></span><span>Share</span></a>'),
    )
    const text = doc.html.replace(/<[^>]+>/g, '')
    expect(text.match(/Share/g)).toHaveLength(1)
  })

  it('keeps the alt of an icon that has no label beside it', async () => {
    const doc = await readHtml(page('<a href="/x"><img src="/_layouts/15/images/spcommon.png" alt="Navigate Up" /></a>'))
    expect(doc.html).toContain('[Navigate Up]')
  })

  it('leaves a data: URI untouched', async () => {
    const uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    const doc = await readHtml(img(`src="${uri}" alt="Inline"`))
    expect(doc.html).toContain('<img')
    expect(doc.html).toContain(uri)
  })

  it('leaves http and https images untouched', async () => {
    for (const s of ['http://example.com/a.png', 'https://example.com/a.png']) {
      const doc = await readHtml(img(`src="${s}" alt="Remote"`))
      expect(doc.html, s).toContain(s)
    }
  })
})

describe('the saved SharePoint page', () => {
  const file = join(CORPUS, 'branch-directory.html')
  const load = async () => readHtml({ bytes: await readFile(file) })

  it('no longer glues screen-reader furniture onto visible labels', async () => {
    if (!existsSync(file)) return
    const { html } = await load()
    for (const glued of [
      'Team DocumentsCurrently selected',
      'BrowseTab 1 of 3.',
      'ItemsList Tools group. Tab 2 of 3.',
      'ListList Tools group. Tab 3 of 3.',
    ]) {
      expect(html.replace(/<[^>]+>/g, '')).not.toContain(glued)
    }
    expect(html).toContain('Team Documents')
  })

  it('leaves no unresolvable <img> behind', async () => {
    if (!existsSync(file)) return
    const { html } = await load()
    expect(html).not.toContain('<img')
    // Root-relative <a href> values survive — a dead link still reads as text.
    expect(html).not.toContain('spcommon.png')
    expect(html).toContain('<span>[Navigate Up]</span>')
  })
})
