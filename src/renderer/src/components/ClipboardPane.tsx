import { useEffect, type MutableRefObject } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { EDITOR_EXTENSIONS } from '../lib/editor-extensions'
import { clearlyMarkdown, shouldUseHtmlFlavor } from '../../../core/paste-flavors'
import { focusAtStart } from '../lib/block-views'
import { EditorToolbar } from './EditorToolbar'
import type { LiveEdit } from '../lib/items'

/**
 * Formatted preview/edit pane for input that arrives as HTML rather than as a
 * file: rich clipboard content, a fetched web page, and pasted markdown or
 * plain text rendered by its own reader. Receives ONLY sanitized HTML — raw
 * markup must never reach this component. The parent reads the (possibly
 * edited) HTML back through `liveRef`, which names the item it belongs to so
 * the parent can never pair one item's id with another pane's content.
 *
 * The editor's content lives ONLY here. The parent must read it through
 * `liveRef` and store it before doing anything that unmounts this component.
 */
export function ClipboardPane({
  itemId,
  html,
  sourceLabel,
  sourceFormat,
  liveRef,
  onReset,
}: {
  itemId: string
  html: string
  sourceLabel: string
  /** The format the document was read from (the toolbar hides inserts for code listings). */
  sourceFormat?: string
  liveRef: MutableRefObject<(() => LiveEdit) | null>
  onReset: () => void
}): React.JSX.Element {
  // Focus the document as soon as the pane opens. Without this the caret stays
  // on the page, where Ctrl+A selects the whole app — the header and buttons
  // along with the content — and Ctrl+X is a silent no-op, because a page
  // selection is not editable and Chromium writes nothing to the clipboard. So
  // "select all, cut, paste into Word" quietly pasted whatever was on the
  // clipboard beforehand.
  // A diagram or formula at the very start is selected, not opened for editing.
  const editor = useEditor({
    extensions: EDITOR_EXTENSIONS,
    content: html,
    autofocus: false,
    editorProps: {
      // Markdown pasted into the open pane arrives formatted, as it does on the
      // start screen, read by the reader the conversion uses. Into a code block
      // it stays text. pasteHTML comes back here with no clipboard and passes.
      handlePaste: (view, event) => {
        const plain = event.clipboardData?.getData('text/plain') ?? ''
        const rich = event.clipboardData?.getData('text/html') ?? ''
        if (view.state.selection.$from.parent.type.spec.code || !clearlyMarkdown(plain) || shouldUseHtmlFlavor(rich, plain)) return false
        window.api.textToHtml(plain, 'md').then(
          (hub) => {
            if (!view.isDestroyed) view.pasteHTML(hub)
          },
          () => {
            if (!view.isDestroyed) view.pasteText(plain)
          },
        )
        return true
      },
    },
    onCreate: ({ editor: e }) => {
      if (!e.isDestroyed) focusAtStart(e)
    },
  })

  useEffect(() => {
    liveRef.current = () => ({ id: itemId, html: editor?.getHTML() ?? html })
    return () => {
      liveRef.current = null
    }
  }, [editor, html, itemId, liveRef])

  return (
    <div className="card clip-pane">
      <div className="card__row">
        <span className="card__label">Input</span>
        <span className="card__name">{sourceLabel}</span>
        <button className="btn btn--ghost" onClick={onReset}>
          Change
        </button>
      </div>
      <EditorToolbar editor={editor} sourceFormat={sourceFormat} />
      <EditorContent editor={editor} className="clip-pane__editor" />
    </div>
  )
}
