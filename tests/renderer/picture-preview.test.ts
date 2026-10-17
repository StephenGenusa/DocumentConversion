// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { Editor } from '@tiptap/core'
import { EDITOR_EXTENSIONS } from '../../src/renderer/src/lib/editor-extensions'
import { setPicturePreview } from '../../src/renderer/src/lib/picture-preview'

/*
 * A TIFF, EMF or WMF in the editor (picture-preview.ts): shown by a copy
 * main makes, the node keeping the picture itself.
 */

const TIFF = 'data:image/tiff;base64,SUkqAAgAAAA='
const EMF = 'data:image/x-emf;base64,AQAAAA=='
const PNG = 'data:image/png;base64,iVBORw0KGgo='
const COPY = 'data:image/png;base64,Q09QWQ=='

let asked: string[] = []
let editor: Editor | null = null
let host: HTMLElement

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  asked = []
  setPicturePreview(async (src) => {
    asked.push(src)
    return src === EMF ? { error: 'could not be drawn' } : { uri: COPY }
  })
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(() => {
  editor?.destroy()
  editor = null
  host.remove()
  setPicturePreview(null)
})

const make = (content: string): Editor => (editor = new Editor({ element: host, extensions: EDITOR_EXTENSIONS, content }))

describe('pictures the page cannot show', () => {
  it('shows a TIFF by its copy and keeps the TIFF in the document', async () => {
    const e = make(`<p><img src="${TIFF}" alt="lease.tif (page 1 of 2)" width="300" height="400"></p>`)
    await settle()
    const img = host.querySelector('img')!
    expect(img.getAttribute('src')).toBe(COPY)
    expect(img.getAttribute('alt')).toBe('lease.tif (page 1 of 2)')
    expect(img.getAttribute('width')).toBe('300')
    expect(e.getHTML()).toContain(`src="${TIFF}"`)
    expect(e.getHTML()).not.toContain(COPY)
  })

  it('asks for each picture once, however often it is shown', async () => {
    make(`<p><img src="${TIFF}" alt="a"></p><p><img src="${TIFF}" alt="b"></p>`)
    await settle()
    expect(asked).toEqual([TIFF])
    expect([...host.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([COPY, COPY])
  })

  it('leaves a picture the page shows alone, and one with no copy without a src', async () => {
    make(`<p><img src="${PNG}" alt="shown"></p><p><img src="${EMF}" alt="drawing"></p>`)
    await settle()
    const [png, emf] = [...host.querySelectorAll('img')]
    expect(png.getAttribute('src')).toBe(PNG)
    expect(emf.hasAttribute('src')).toBe(false)
    expect(emf.getAttribute('alt')).toBe('drawing')
    expect(asked).toEqual([EMF])
  })
})
