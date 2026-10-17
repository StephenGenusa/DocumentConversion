import { mergeSettings, type Settings } from '../core/settings'
import { normalizeSlideOptions } from '../core/slides'
import type { ConvertOptions, WebPolicy } from '../core/types'

/** Settings → Web, for a read that is not a conversion: a paste, a web page opened as an input. */
export function webPolicy(settings: Readonly<Settings>): WebPolicy {
  return { fetchPictures: settings.web.fetchPictures, allowLocalNetwork: settings.web.allowLocalNetwork }
}

/**
 * The options a conversion started from the window runs with (settings spec
 * 5.6): the saved settings, with the request's shown controls on top.
 *
 * The renderer sends only the controls it shows (`appliedOptions`), so a value
 * in `request` is one the user can see and it wins for this conversion; the
 * rest come from `settings`. Picture format, code color and the web settings
 * have no control on the screen and are never read from a request. Each handler takes
 * `settings` once, when its job starts, so a change made during a conversion
 * applies to the next one.
 *
 * Pure: no Electron, so it is tested on its own. The CLI does not come here;
 * it has its own defaults and flags (cli-run.ts).
 */
export function conversionOptions(settings: Readonly<Settings>, request: unknown): ConvertOptions {
  const req = typeof request === 'object' && request !== null ? (request as Record<string, unknown>) : {}
  const merged = mergeSettings(settings, req)
  return {
    pdf: merged.pdf,
    slides: normalizeSlideOptions(req.slides),
    renderedFormat: merged.renderedFormat,
    pictureFormat: merged.pictureFormat,
    ocr: req.ocr === true,
    ocrLanguage: merged.ocrLanguage,
    read: merged.read,
    codeColor: merged.codeColor,
    web: webPolicy(settings),
  }
}
