import type {
  ConvertOptions,
  HubDocument,
  ReadContext,
  RenderHtmlToPdf,
  SourceFormat,
  SourceInput,
  TargetFormat,
  WriteResult,
} from './types'
import { ConversionError } from './errors'
import { getReader } from './readers'
import { stripXmlIllegal } from './allowlist'
import { stripSpeakerNotes } from './speaker-notes'
import { SLIDE_TARGETS } from './types'
import { createWriters, type Writer } from './writers'

export interface Converter {
  convert(
    src: SourceInput,
    source: SourceFormat,
    target: TargetFormat,
    opts?: ConvertOptions,
    ctx?: ReadContext,
  ): Promise<WriteResult>
  /** Read a source to its hub document without writing (used by merge). */
  read(src: SourceInput, source: SourceFormat, ctx?: ReadContext): Promise<HubDocument>
  /** Write an already-built hub document (used by the OCR recovery path and merge). */
  write(hub: HubDocument, target: TargetFormat, opts?: ConvertOptions): Promise<WriteResult>
}

export function createConverter(render: RenderHtmlToPdf): Converter {
  const writers: Record<TargetFormat, Writer> = createWriters(render)

  async function read(src: SourceInput, source: SourceFormat, ctx?: ReadContext): Promise<HubDocument> {
    try {
      const hub = await getReader(source)(src, ctx)
      if (!hub.sourceName && src.filename) hub.sourceName = src.filename
      // The hub contract every writer relies on, applied where every reader's
      // output passes. Most readers do not sanitise, and the docx and epub
      // writers emit XML, which refuses these characters outright.
      hub.html = stripXmlIllegal(hub.html)
      if (hub.title) hub.title = stripXmlIllegal(hub.title)
      return hub
    } catch (err) {
      if (err instanceof ConversionError) throw err
      throw new ConversionError('read-failed', `Could not read ${source}: ${(err as Error).message}`)
    }
  }

  async function write(hub: HubDocument, target: TargetFormat, opts?: ConvertOptions): Promise<WriteResult> {
    try {
      // The OCR recovery and merge paths build a hub without passing read().
      hub.html = stripXmlIllegal(hub.html)
      // Speaker notes round-trip the hub and the editor, but they are not body
      // content: no ordinary writer should emit them. Dropped once here rather
      // than in each writer, for the same reason the XML-illegal strip lives at
      // this boundary.
      //
      // Slide targets are the exception - notes are the whole point there - so
      // they are exempted rather than being handed a document with the notes
      // already removed. Missing this is invisible to a writer unit test,
      // which calls the writer directly and never crosses this boundary.
      const html = SLIDE_TARGETS.includes(target) ? hub.html : stripSpeakerNotes(hub.html)
      return await writers[target](html === hub.html ? hub : { ...hub, html }, opts)
    } catch (err) {
      if (err instanceof ConversionError) throw err
      throw new ConversionError('write-failed', `Could not write ${target}: ${(err as Error).message}`)
    }
  }

  return {
    read,
    write,
    async convert(src, source, target, opts, ctx) {
      return write(await read(src, source, ctx), target, opts)
    },
  }
}
