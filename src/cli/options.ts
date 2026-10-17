import { mergeSettings, type Settings } from '../core/settings'
import { BUNDLED_LANGUAGE } from '../ocr/languages'
import type { ConvertOptions } from '../core/types'
import type { CliRequest } from './args'

/**
 * The options a command-line conversion runs with (settings spec 5.7): the
 * settings - the built-in DEFAULT_SETTINGS, or a file given with --settings -
 * with the flags on top. The same merge the window uses (`mergeSettings`), so
 * a setting means the same thing in both.
 *
 * A flag wins over the file. A flag left off leaves the file's value, so a
 * file's header and footer stays on without --header-footer. A file value
 * that cannot apply to this run is simply not used (a page size for html
 * output); only flags are strict, and args.ts has checked them.
 *
 * `ocrInstalled` says whether a language's pack is on this machine. A file's
 * language that is not installed falls back to English, as the window's does;
 * a flag's is a usage error, since the user asked for it by name.
 */
export function cliConvertOptions(
  settings: Readonly<Settings>,
  req: CliRequest,
  ocrInstalled: (code: string) => boolean,
): { kind: 'ok'; options: ConvertOptions; notes: string[] } | { kind: 'usage'; message: string } {
  if (req.ocrLang && !ocrInstalled(req.ocrLang)) {
    return { kind: 'usage', message: `--ocr-lang: ${req.ocrLang} is not installed; download it in the app first` }
  }
  const notes: string[] = []
  let fileLanguage = settings.ocr.language
  if (!req.ocrLang && !ocrInstalled(fileLanguage)) {
    if (req.ocr) notes.push(`The settings file's OCR language (${fileLanguage}) is not installed; English is used.`)
    fileLanguage = BUNDLED_LANGUAGE
  }
  // Only what a flag set goes in the request: an absent value is the setting's.
  const merged = mergeSettings(
    { ...settings, ocr: { language: fileLanguage } },
    {
      pdf: {
        scale: req.scale,
        pageSize: req.page,
        landscape: req.landscape,
        headerFooter: req.headerFooter ? true : req.noHeaderFooter ? false : undefined,
      },
      renderedFormat: req.diagrams,
      read: {
        jsonAs: req.jsonAs,
        transcriptTimestamps: req.noTimestamps ? false : undefined,
        sqliteViews: req.sqliteViews ? true : undefined,
      },
      ocrLanguage: req.ocrLang,
    },
  )
  return {
    kind: 'ok',
    notes,
    options: {
      pdf: merged.pdf,
      slides: { splitOn: req.split ?? 'auto' },
      renderedFormat: merged.renderedFormat,
      // The settings with no control on the window's screen: mergeSettings
      // never takes them from a request, so the flags are applied here.
      pictureFormat: req.pictures ?? merged.pictureFormat,
      // Each on/off pair: whichever flag was given, else the setting (args.ts
      // has refused both at once).
      codeColour: req.codeColor ? true : req.noCodeColor ? false : merged.codeColour,
      web: {
        fetchPictures: req.fetch ? true : req.noFetch ? false : merged.fetchPictures,
        allowLocalNetwork: req.localNetwork ? true : req.noLocalNetwork ? false : merged.allowLocalNetwork,
      },
      ocr: req.ocr,
      ocrLanguage: merged.ocrLanguage,
      read: merged.read,
    },
  }
}
