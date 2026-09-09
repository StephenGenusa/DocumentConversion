import { existsSync, statSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { basename, dirname, resolve } from 'path'
import { app } from 'electron'
import { parseArgs, USAGE } from '../cli/args'
import { mergeToTarget, runConversion } from './conversion'
import { detect } from '../core/detect'
import { allowedTargets } from '../core/target-validity'
import { expandZipArchive } from '../core/zip-expand'
import { normalizePdfOptions } from '../core/pdf-options'
import { resolveOutPath } from '../cli/out-path'
import { EXTENSIONS, type SourceFormat, type WritePart } from '../core/types'

interface LoadedInputFile {
  path: string
  /** Only archive entries carry bytes; real files are re-read when converted. */
  bytes?: Buffer
  source: SourceFormat
}


/**
 * Headless `convert` runner (spec F9). Overwrites by default (deterministic
 * paths for scripts — pandoc precedent); --no-clobber fails instead.
 * Exit codes: 0 all succeeded, 1 any failed, 2 bad usage.
 */
export async function runCli(argv: string[]): Promise<number> {
  // Without this, any non-`convert` argv fell through to the GUI and hung a
  // console (and CI) forever instead of printing usage.
  if (argv.some((a) => a === '--help' || a === '-h' || a === 'help')) {
    console.log(USAGE)
    return 0
  }
  if (argv.some((a) => a === '--version' || a === '-v')) {
    console.log(app.getVersion())
    return 0
  }
  const parsed = parseArgs(argv)
  if (parsed.kind === 'usage') {
    console.error(parsed.message)
    return 2
  }
  const req = parsed.req
  const opts = {
    pdf: normalizePdfOptions({
      scale: req.scale,
      pageSize: req.page,
      landscape: req.landscape,
      headerFooter: req.headerFooter,
    }),
    slides: { splitOn: req.split ?? 'auto' },
    ocr: req.ocr,
  }

  let failed = 0

  /**
   * Resolve inputs to a work list WITHOUT holding their bytes: reading all of
   * them up front meant a 94 MB corpus peaked at 2 GB (4 GB to docx). Only
   * archive entries, which have no path of their own, keep their buffer.
   */
  const loaded: LoadedInputFile[] = []
  for (const input of req.inputs) {
    try {
      const bytes = await readFile(input)
      if (req.from) {
        loaded.push({ path: input, source: req.from })
        continue
      }
      const det = detect(bytes, basename(input))
      if (det.kind === 'unsupported') throw new Error(det.reason)
      if (det.kind === 'archive') {
        // A zip contributes its convertible entries as separate inputs.
        for (const entry of await expandZipArchive(bytes)) {
          const entryDet = detect(entry.bytes, entry.filename)
          if (entryDet.kind !== 'ok') continue
          loaded.push({ path: entry.filename, bytes: entry.bytes, source: entryDet.format })
        }
        continue
      }
      loaded.push({ path: input, source: det.format })
    } catch (err) {
      console.error(`ERROR ${input}: ${(err as Error).message}`)
      failed++
    }
  }
  if (loaded.length === 0) return 1

  const bytesFor = (f: LoadedInputFile): Promise<Buffer> => (f.bytes ? Promise.resolve(f.bytes) : readFile(f.path))

  // Two inputs from different folders can share a basename; overwriting by
  // default then destroyed one of them at exit 0. Disambiguate instead.
  const claimed = new Set<string>()
  function claim(outPath: string): string {
    if (!claimed.has(outPath)) {
      claimed.add(outPath)
      return outPath
    }
    const ext = /\.[^.\\/]+$/.exec(outPath)?.[0] ?? ''
    const stem = ext ? outPath.slice(0, -ext.length) : outPath
    for (let i = 2; ; i++) {
      const candidate = `${stem}-${i}${ext}`
      if (!claimed.has(candidate)) {
        claimed.add(candidate)
        return candidate
      }
    }
  }

  async function writeOut(outPath: string, bytes: Buffer): Promise<void> {
    if (req.noClobber && existsSync(outPath)) {
      throw new Error(`refusing to overwrite (--no-clobber): ${outPath}`)
    }
    await mkdir(dirname(resolve(outPath)), { recursive: true })
    await writeFile(outPath, bytes)
    console.log(outPath)
  }

  function selectTable(parts: WritePart[]): WritePart[] {
    // csv and json both write one file per table; --table selects one of them.
    if (!req.table || (req.to !== 'csv' && req.to !== 'json')) return parts
    const part = parts[req.table - 1]
    if (!part) throw new Error(`table ${req.table} not found (document has ${parts.length})`)
    return [{ suffix: '', bytes: part.bytes }]
  }

  if (req.merge) {
    try {
      const items = await Promise.all(
        loaded.map(async (f) => ({
          bytes: await bytesFor(f),
          filename: basename(f.path),
          source: f.source,
          ocr: req.ocr,
        })),
      )
      const out = await mergeToTarget(
        items,
        req.to,
        opts,
        req.headings,
        {},
      )
      await writeOut(req.out!, out.parts[0].bytes)
    } catch (err) {
      console.error(`ERROR merge: ${(err as Error).message}`)
      return 1
    }
    return failed ? 1 : 0
  }

  const outIsDir =
    req.out !== undefined && (loaded.length > 1 || (existsSync(req.out) && statSync(req.out).isDirectory()))
  if (outIsDir) await mkdir(req.out!, { recursive: true })

  for (const f of loaded) {
    try {
      // The GUI disables invalid targets; the CLI must refuse them rather than
      // writing, say, a base64 data URI into a .txt file.
      const valid = allowedTargets([{ format: f.source, imageMode: req.ocr ? 'ocr' : 'embed' }])
      if (!valid.includes(req.to)) {
        throw new Error(
          `cannot convert ${f.source} to ${req.to}` +
            (f.source === 'image' && !req.ocr ? ' — add --ocr to read the text in an image' : ''),
        )
      }
      const out = await runConversion(await bytesFor(f), basename(f.path), f.source, req.to, opts, {
        onAdvice: (_kind, message, suggestion) => {
          const flags = suggestion
            ? ` Try: --page ${suggestion.pageSize}${suggestion.landscape ? ' --landscape' : ''}`
            : ''
          console.error(`NOTE ${basename(f.path)}: ${message}.${flags}`)
        },
      })
      const parts = selectTable(out.parts)
      for (const part of parts) {
        await writeOut(
          claim(
            resolveOutPath({
              out: req.out,
              outIsDir,
              inputPath: f.path,
              suffix: part.suffix,
              ext: EXTENSIONS[req.to],
            }),
          ),
          part.bytes,
        )
      }
    } catch (err) {
      console.error(`ERROR ${f.path}: ${(err as Error).message}`)
      failed++
    }
  }
  return failed ? 1 : 0
}
