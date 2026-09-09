/**
 * The OCR language catalogue.
 *
 * English ships in the installer. Everything else is downloaded on request,
 * never automatically: this app's claim is that nothing leaves the machine, and
 * a language pack fetched silently on first use would break that on the one
 * axis the project sells on. A download has to be visible, refusable, and
 * absent unless asked for.
 *
 * Deliberately dependency-free and Electron-free, so the catalogue can be
 * tested, and reasoned about, without a network or a filesystem.
 */

/** Which model set a pack came from. Both are offered; they differ in kind. */
export type ModelSet = 'fast' | 'best'

/**
 * The script a language is written in.
 *
 * This is not decoration. `MIN_CONFIDENCE` was tuned against English on Latin
 * script; there is no reason for that number to hold for Arabic or Han, and a
 * confidence gate set wrong is worse than a missing language - the gate is what
 * stops the reader emitting plausible nonsense.
 */
export type Script = 'latin' | 'cyrillic' | 'arabic' | 'devanagari' | 'han' | 'kana' | 'hangul' | 'greek' | 'hebrew' | 'thai'

export interface OcrLanguage {
  /** Tesseract's own code, e.g. `deu`. This is the filename stem too. */
  code: string
  /** What to show a person. */
  name: string
  script: Script
  /** Approximate download size in bytes, per model set, for the UI to show. */
  size: Record<ModelSet, number>
}

/**
 * Confidence floors per script.
 *
 * Latin's 55 is the number the English pipeline was tuned to and is kept
 * exactly. The others are NOT measured - they are placeholders set no lower
 * than Latin, so an unmeasured script cannot be more permissive than the one
 * that was actually calibrated. Each must be replaced with a measured value
 * before its language is offered as more than experimental.
 */
export const CONFIDENCE_FLOOR: Record<Script, number> = {
  latin: 55,
  cyrillic: 55,
  greek: 55,
  hebrew: 55,
  arabic: 60,
  devanagari: 60,
  han: 60,
  kana: 60,
  hangul: 60,
  thai: 60,
}

/** The one pack in the installer. Everything else is a download. */
export const BUNDLED_LANGUAGE = 'eng'

/**
 * Orientation and script detection, bundled alongside English.
 *
 * Small, and it is what lets the app say "this looks like Cyrillic, and no
 * Cyrillic pack is installed" instead of returning confident nonsense or
 * failing mutely. Without it an English-only install cannot explain itself.
 */
export const BUNDLED_OSD = 'osd'

export const LANGUAGES: OcrLanguage[] = [
  { code: 'eng', name: 'English', script: 'latin', size: { fast: 4_113_088, best: 12_054_016 } },
  { code: 'spa', name: 'Spanish', script: 'latin', size: { fast: 2_500_000, best: 9_000_000 } },
  { code: 'fra', name: 'French', script: 'latin', size: { fast: 2_400_000, best: 8_800_000 } },
  { code: 'deu', name: 'German', script: 'latin', size: { fast: 2_000_000, best: 8_100_000 } },
  { code: 'por', name: 'Portuguese', script: 'latin', size: { fast: 2_300_000, best: 8_400_000 } },
  { code: 'ita', name: 'Italian', script: 'latin', size: { fast: 2_300_000, best: 8_600_000 } },
  { code: 'nld', name: 'Dutch', script: 'latin', size: { fast: 2_400_000, best: 9_100_000 } },
  { code: 'pol', name: 'Polish', script: 'latin', size: { fast: 2_600_000, best: 9_300_000 } },
  { code: 'tur', name: 'Turkish', script: 'latin', size: { fast: 2_500_000, best: 9_200_000 } },
  { code: 'vie', name: 'Vietnamese', script: 'latin', size: { fast: 2_400_000, best: 8_700_000 } },
  { code: 'ind', name: 'Indonesian', script: 'latin', size: { fast: 1_800_000, best: 7_500_000 } },
  { code: 'rus', name: 'Russian', script: 'cyrillic', size: { fast: 3_000_000, best: 12_000_000 } },
  { code: 'ukr', name: 'Ukrainian', script: 'cyrillic', size: { fast: 2_700_000, best: 10_500_000 } },
  { code: 'ell', name: 'Greek', script: 'greek', size: { fast: 2_100_000, best: 8_000_000 } },
  { code: 'heb', name: 'Hebrew', script: 'hebrew', size: { fast: 1_800_000, best: 7_000_000 } },
  { code: 'ara', name: 'Arabic', script: 'arabic', size: { fast: 2_200_000, best: 8_500_000 } },
  { code: 'fas', name: 'Persian', script: 'arabic', size: { fast: 2_100_000, best: 8_200_000 } },
  { code: 'hin', name: 'Hindi', script: 'devanagari', size: { fast: 2_500_000, best: 9_500_000 } },
  { code: 'ben', name: 'Bengali', script: 'devanagari', size: { fast: 2_400_000, best: 9_200_000 } },
  { code: 'tam', name: 'Tamil', script: 'devanagari', size: { fast: 2_300_000, best: 8_900_000 } },
  { code: 'tha', name: 'Thai', script: 'thai', size: { fast: 2_200_000, best: 8_600_000 } },
  { code: 'chi_sim', name: 'Chinese (Simplified)', script: 'han', size: { fast: 4_500_000, best: 20_000_000 } },
  { code: 'chi_tra', name: 'Chinese (Traditional)', script: 'han', size: { fast: 4_700_000, best: 21_000_000 } },
  { code: 'jpn', name: 'Japanese', script: 'kana', size: { fast: 4_200_000, best: 18_000_000 } },
  { code: 'kor', name: 'Korean', script: 'hangul', size: { fast: 4_000_000, best: 17_000_000 } },
]

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]))

export function findLanguage(code: string): OcrLanguage | undefined {
  return BY_CODE.get(code)
}

export function isKnownLanguage(code: string): boolean {
  return BY_CODE.has(code)
}

/** The floor a language's recognition must clear to be reported at all. */
export function confidenceFloorFor(code: string): number {
  const language = findLanguage(code)
  return language ? CONFIDENCE_FLOOR[language.script] : CONFIDENCE_FLOOR.latin
}

/**
 * Where a pack is fetched from.
 *
 * Pinned to a tag, never a branch: `main` would mean the model a user gets
 * depends on the day they asked, and a model is what decides whether their
 * document is read correctly. tessdata_fast and tessdata_best are separate
 * repositories upstream.
 */
export const TESSDATA_TAG = '4.1.0'

export function downloadUrl(code: string, set: ModelSet): string {
  const repo = set === 'best' ? 'tessdata_best' : 'tessdata_fast'
  return `https://raw.githubusercontent.com/tesseract-ocr/${repo}/${TESSDATA_TAG}/${code}.traineddata`
}

/** The filename a pack is stored under, keeping the two model sets apart. */
export function packFilename(code: string, set: ModelSet): string {
  return set === 'best' ? `${code}.best.traineddata` : `${code}.traineddata`
}
