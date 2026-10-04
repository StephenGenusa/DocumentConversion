import { describe, it, expect } from 'vitest'
import { applyLiveEdit, toRequest, markDiskState, keepEdits, type ListItem } from '../../src/renderer/src/lib/items'

/**
 * The input list is the only state that survives the edit pane.
 *
 * The pane is unmounted whenever a result is on screen, and remounted from the
 * list when the result is dismissed. Edits that were read out of the pane for a
 * conversion but never written back to the list were therefore gone the moment
 * the conversion finished: Done brought back the original text, and the next
 * conversion silently produced it.
 */
const text = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8')

const item = (over: Partial<ListItem> = {}): ListItem => ({
  id: 'a',
  label: 'notes.md',
  filename: 'notes.md',
  source: 'md',
  imageMode: 'embed',
  ...over,
})

describe('writing live edits back to the list', () => {
  it('stores the pane html on the item being edited', () => {
    const list = [item({ id: 'a', html: '<p>old</p>' }), item({ id: 'b', html: '<p>other</p>' })]
    const out = applyLiveEdit(list, { id: 'a', html: '<p>new</p>' })
    expect(out.map((i) => i.html)).toEqual(['<p>new</p>', '<p>other</p>'])
  })

  it('leaves the list alone when no pane is open', () => {
    const list = [item({ html: '<p>old</p>' })]
    expect(applyLiveEdit(list, null)).toBe(list)
  })

  it('does not mutate the list it was given', () => {
    const list = [item({ html: '<p>old</p>' })]
    applyLiveEdit(list, { id: 'a', html: '<p>new</p>' })
    expect(list[0].html).toBe('<p>old</p>')
  })
})

describe('what a conversion is asked to read', () => {
  it('sends the handle, and no stored bytes, for a file that is still on disk', () => {
    const req = toRequest(item({ base64: 'c3RhbGU=', handle: 'h1', sourceDir: '/docs' }), 'eng')
    expect(req.handle).toBe('h1')
    expect(req.base64).toBe('')
    expect(req.source).toBe('md')
    expect(req.sourceDir).toBe('/docs')
  })

  it('sends the stored bytes for an input with no file behind it', () => {
    const req = toRequest(item({ base64: 'cGFzdGVk' }), 'eng')
    expect(req.base64).toBe('cGFzdGVk')
    expect(req.handle).toBeUndefined()
  })

  it('sends the edited html, not the file, once an input has been opened in the pane', () => {
    const req = toRequest(item({ base64: 'c3RhbGU=', handle: 'h1', html: '<p>mine</p>' }), 'eng')
    expect(text(req.base64)).toBe('<p>mine</p>')
    expect(req.source).toBe('html')
    expect(req.handle).toBeUndefined()
  })

  it('asks for OCR only for an image set to OCR', () => {
    expect(toRequest(item({ source: 'image', imageMode: 'ocr', base64: '' }), 'deu')).toMatchObject({
      ocr: true,
      ocrLanguage: 'deu',
    })
    expect(toRequest(item({ source: 'image', imageMode: 'embed', base64: '' }), 'deu').ocr).toBe(false)
    expect(toRequest(item({ source: 'pdf', imageMode: 'ocr', base64: '' }), 'deu').ocr).toBe(false)
  })
})

/**
 * Edits win. A file opened in the pane and then changed on disk is NOT
 * re-read behind the user's back; the list records that the disk moved on so
 * the app can offer a reload, and the decision stays with the user.
 */
describe('a file changed on disk after it was opened in the pane', () => {
  const edited = item({ handle: 'h1', html: '<p>mine</p>', diskStamp: 's1' })

  it('is flagged when the disk no longer matches what the pane was loaded from', () => {
    expect(markDiskState(edited, 's2').staleStamp).toBe('s2')
  })

  it('keeps the edits exactly as they were', () => {
    expect(markDiskState(edited, 's2').html).toBe('<p>mine</p>')
  })

  it('is not flagged while the disk still matches', () => {
    expect(markDiskState(edited, 's1')).toBe(edited)
  })

  it('stops being flagged if the file goes back to what it was', () => {
    const flagged = markDiskState(edited, 's2')
    expect(markDiskState(flagged, 's1').staleStamp).toBeUndefined()
  })

  it('is not flagged when the file is gone: the edits are all there is', () => {
    expect(markDiskState(edited, null)).toBe(edited)
  })

  it('never flags an input that is not open in the pane, since that one is re-read anyway', () => {
    const plain = item({ handle: 'h1', base64: '' })
    expect(markDiskState(plain, 's2')).toBe(plain)
  })

  it('choosing to keep the edits dismisses the flag until the file changes again', () => {
    const kept = keepEdits(markDiskState(edited, 's2'))
    expect(kept.staleStamp).toBeUndefined()
    expect(kept.html).toBe('<p>mine</p>')
    expect(markDiskState(kept, 's2')).toBe(kept)
    expect(markDiskState(kept, 's3').staleStamp).toBe('s3')
  })
})
