import Image from '@tiptap/extension-image'
import { getRenderedAttributes, mergeAttributes } from '@tiptap/core'

/*
 * Pictures the editor's page cannot show: a TIFF (Chromium has no TIFF
 * decoder), an EMF or a WMF (Word's vector pictures). A TIFF, EMF or WMF
 * opened on its own, or a Word document holding one, would otherwise sit in
 * the pane as an empty box. Each is shown by a copy main makes the way an
 * HTML conversion would (core/pictures.ts: a TIFF as PNG or JPEG, its first
 * page; a drawing as SVG), asked for once per picture; the node keeps the
 * picture itself, so what is converted, and what Word keeps, is the
 * original, never the copy shown.
 */

/** A data: URL of a picture the page cannot show. */
export const NOT_SHOWN = /^\s*data:image\/(?:tiff|x-emf|x-wmf)[;,]/i

/** What makes the copy shown: main's `picture:preview` in the app, a fake in tests. */
export type PreviewFn = (src: string) => Promise<{ uri: string } | { error: string }>

let previewFn: PreviewFn | null = null
const previews = new Map<string, Promise<string | null>>()

/** Sets what makes the copies (tests), or puts back the app's (null). Forgets the copies made. */
export function setPicturePreview(fn: PreviewFn | null): void {
  previewFn = fn
  previews.clear()
}

/** The copy shown for `src`, made once; null when it cannot be made. */
export function previewOf(src: string): Promise<string | null> {
  let p = previews.get(src)
  if (!p) {
    const fn = previewFn ?? (typeof window !== 'undefined' ? window.api?.previewPicture : undefined)
    p = fn
      ? fn(src).then(
          (r) => ('uri' in r ? r.uri : null),
          () => null,
        )
      : Promise.resolve(null)
    previews.set(src, p)
  }
  return p
}

/** The editor's image node, showing a copy of a picture the page cannot show (above). */
export const PreviewedImage = Image.extend({
  addNodeView() {
    return ({ node, HTMLAttributes, editor }) => {
      const el = document.createElement('img')
      let set = new Set<string>()
      let original = ''
      const apply = (attrs: Record<string, unknown>): void => {
        for (const key of set) if (!(key in attrs) || attrs[key] == null) el.removeAttribute(key)
        set = new Set()
        for (const [key, value] of Object.entries(attrs)) {
          if (key === 'src' || value == null) continue
          el.setAttribute(key, String(value))
          set.add(key)
        }
        const src = typeof attrs.src === 'string' ? attrs.src : ''
        if (src && NOT_SHOWN.test(src)) {
          if (src === original) return
          original = src
          el.removeAttribute('src')
          el.classList.add('img--preview')
          void previewOf(src).then((uri) => {
            if (uri && original === src) el.src = uri
          })
          return
        }
        original = ''
        el.classList.remove('img--preview')
        if (src) el.src = src
        else el.removeAttribute('src')
      }
      apply(mergeAttributes(this.options.HTMLAttributes, HTMLAttributes))
      return {
        dom: el,
        update: (updated) => {
          if (updated.type !== node.type) return false
          const attributes = editor.extensionManager.attributes.filter((a) => a.type === updated.type.name)
          apply(mergeAttributes(this.options.HTMLAttributes, getRenderedAttributes(updated, attributes)))
          return true
        },
      }
    }
  },
})
