import type {
  ConvertOptions,
  HubDocument,
  ReadContext,
  RenderHtmlToPdf,
  SourceFormat,
  SourceInput,
  TargetFormat,
  WriteContext,
  WriteResult,
} from './types'
import { ConversionError } from './errors'
import { getReader, type Reader, type RowReader } from './readers'
import { sqliteReader, sqliteRowReader } from './readers/sqlite'
import type { SqliteEngine } from './sqlite'
import { stripXmlIllegal } from './allowlist'
import { stripSpeakerNotes } from './speaker-notes'
import { SLIDE_TARGETS } from './types'
import { createWriters, type Writer } from './writers'
import { dropRemoteImages } from './inline-images'
import { resolveRemoteImages } from './remote-images'
import { getRowReader } from './readers'
import { writeRows, type RowWriteOptions } from './writers/rows'
import type { RowSource } from './records'
import { TABLE_TARGETS } from './types'
import { normalizeFootnotes } from './footnotes'
import { guessCodeLanguages } from './code-language'
import { hubFeatures, type RenderBlocks } from './rendered-blocks'
import { drawBlocks } from './draw-blocks'
import { rasterizeSvgImages, sanitizeSvgImages } from './svg-images'
import { targetPictures } from './pictures'
import type { GuardedFetchDeps } from './net/guarded-fetch'

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
  /**
   * Write an already-built hub document (used by the OCR recovery path and
   * merge). `ctx` carries the cancel signal and the notices for diagrams that
   * could not be drawn.
   */
  write(hub: HubDocument, target: TargetFormat, opts?: ConvertOptions, ctx?: WriteContext): Promise<WriteResult>
  /**
   * A record source's rows, for a table target: every record, never via the
   * hub. Null when the source is not records (or has no row reader).
   */
  readRows(src: SourceInput, source: SourceFormat, ctx?: ReadContext): Promise<RowSource[] | null>
  /** csv/json/xlsx from row sources. */
  writeRows(sources: RowSource[], target: TargetFormat, opts?: RowWriteOptions): Promise<WriteResult>
}

export interface ConverterDeps {
  /**
   * Network access for embedding a document's remote images at read time.
   * Without it nothing is fetched and those images become their alt text.
   */
  fetchImages?: GuardedFetchDeps
  /**
   * The SQLite engine (sql.js in a main-process worker, see core/sqlite.ts).
   * Without it a database is refused: "SQLite databases need the desktop app".
   */
  sqlite?: SqliteEngine
  /**
   * The render host (spec B5, src/main/render-host.ts): draws Mermaid
   * diagrams for the targets that show pictures. Without it every diagram
   * stays as source, silently.
   */
  renderBlocks?: RenderBlocks
}

export function createConverter(render: RenderHtmlToPdf, deps: ConverterDeps = {}): Converter {
  const writers: Record<TargetFormat, Writer> = createWriters(render)

  // Readers are plain (src, ctx) functions and get no deps; a reader that
  // needs a host service is a factory, bound here to this converter's deps.
  // The registry's own entry for it is the unbound one, which refuses, so a
  // caller going round the converter (getReader) cannot reach a missing engine.
  const bound: Partial<Record<SourceFormat, { read: Reader; rows: RowReader }>> = {
    sqlite: { read: sqliteReader(deps.sqlite), rows: sqliteRowReader(deps.sqlite) },
  }

  async function read(src: SourceInput, source: SourceFormat, ctx?: ReadContext): Promise<HubDocument> {
    try {
      const hub = await (bound[source]?.read ?? getReader(source))(src, ctx)
      if (!hub.sourceName && src.filename) hub.sourceName = src.filename
      // The hub contract every writer relies on, applied where every reader's
      // output passes. Most readers do not sanitise, and the docx and epub
      // writers emit XML, which refuses these characters outright.
      hub.html = stripXmlIllegal(hub.html)
      if (hub.title) hub.title = stripXmlIllegal(hub.title)
      // Notes numbered by first reference, once, as the document arrives.
      hub.html = normalizeFootnotes(hub.html, { reorder: true })
      // A code block no reader could name the language of is given a guessed
      // one, so every writer highlights it alike (code-language.ts).
      hub.html = guessCodeLanguages(hub.html)
      // Embedded here, at the one boundary every reader's output passes, so
      // that the edit pane and every writer see data URIs only.
      hub.html = await resolveRemoteImages(hub.html, source, deps.fetchImages, ctx)
      // Every SVG image, from whichever reader or fetch, cleaned (spec B6)
      // before the editor shows it or a writer embeds it.
      hub.html = sanitizeSvgImages(hub.html)
      hub.features = hubFeatures(hub.html)
      return hub
    } catch (err) {
      if (err instanceof ConversionError) throw err
      throw new ConversionError('read-failed', `Could not read ${source}: ${(err as Error).message}`)
    }
  }

  async function write(
    hub: HubDocument,
    target: TargetFormat,
    opts?: ConvertOptions,
    ctx?: WriteContext,
  ): Promise<WriteResult> {
    try {
      // The OCR recovery and merge paths build a hub without passing read().
      // A remote image still here would be fetched by the docx and pdf
      // writers outside the guarded fetcher, so it is dropped, never fetched.
      hub.html = dropRemoteImages(stripXmlIllegal(hub.html))
      // Pasted, merged and OCR hubs did not pass read() either: B6 here too.
      hub.html = sanitizeSvgImages(hub.html)
      // Edited, merged and OCR hubs reach here without read(): one notes list,
      // last, numbered as the notes stand (the editor showed that numbering).
      hub.html = normalizeFootnotes(hub.html)
      // Speaker notes round-trip the hub and the editor, but they are not body
      // content: no ordinary writer should emit them. Dropped once here rather
      // than in each writer, for the same reason the XML-illegal strip lives at
      // this boundary.
      //
      // Slide targets are the exception - notes are the whole point there - so
      // they are exempted rather than being handed a document with the notes
      // already removed. Missing this is invisible to a writer unit test,
      // which calls the writer directly and never crosses this boundary.
      const notesFree = SLIDE_TARGETS.includes(target) ? hub.html : stripSpeakerNotes(hub.html)
      // Diagrams drawn last, on the html the writer is about to get, so a
      // merged document is drawn once and nothing drawn reaches the hub.
      const drawCtx = {
        renderBlocks: deps.renderBlocks,
        format: opts?.renderedFormat,
        svgImagesAsPng: opts?.svgImagesAsPng,
        pictureFormat: opts?.pictureFormat,
        signal: ctx?.signal,
        onAdvice: ctx?.onAdvice,
      }
      const drawn = await drawBlocks(notesFree, target, drawCtx)
      // PNG copies of the document's SVG images for Word and Kindle (spec
      // D10), and for HTML that is to be pasted (FOR_PASTING).
      const rasterised = await rasterizeSvgImages(drawn, target, drawCtx)
      // Pictures the target cannot hold (a TIFF in a PDF, a WebP in a Kindle
      // book), converted, once, for every writer (pictures.ts).
      const html = await targetPictures(rasterised, target, drawCtx)
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
      const readCtx = opts?.read ? { ...ctx, ...opts.read } : ctx
      if (TABLE_TARGETS.includes(target)) {
        const rows = await this.readRows(src, source, readCtx)
        if (rows) return writeRows(rows, target, { signal: ctx?.signal, onProgress: ctx?.onProgress })
      }
      return write(await read(src, source, readCtx), target, opts, ctx)
    },
    async readRows(src, source, ctx) {
      const reader = bound[source]?.rows ?? getRowReader(source)
      if (!reader) return null
      try {
        return await reader(src, ctx)
      } catch (err) {
        if (err instanceof ConversionError) throw err
        throw new ConversionError('read-failed', `Could not read ${source}: ${(err as Error).message}`)
      }
    },
    writeRows(sources, target, opts) {
      return writeRows(sources, target, opts)
    },
  }
}
