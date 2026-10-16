/**
 * @lingo-reader/mobi-parser's initKf8File, with kindle:embed read in base 32.
 *
 * KF8 numbers its embedded resources in base 32 (digits 0-9, A-V; kindlegen
 * and Calibre both), but mobi-parser 0.x reads them with parseInt(id, 36), so
 * from the 32nd picture on ("0010") it loads the wrong record — record 36 for
 * picture 32 — and a book with many pictures looks broken when it is not.
 *
 * The library is left as it is. Before it resolves a chapter's references,
 * each embed id is respelled in base 36 with the same value, so its own
 * parseInt(id, 36) lands on the record the book means. A flow reference
 * (kindle:flow) is decimal there and left alone. Test-only: the app never
 * reads AZW3.
 */
import { initKf8File as libraryInit } from '@lingo-reader/mobi-parser'

const EMBED = /kindle:embed:([0-9A-Va-v]+)/g

export function respellEmbeds(str) {
  return str.replace(EMBED, (_, id) => `kindle:embed:${Number.parseInt(id, 32).toString(36).toUpperCase().padStart(4, '0')}`)
}

export async function initKf8File(file, resourceSaveDir) {
  const kf8 = await libraryInit(file, resourceSaveDir)
  const replace = kf8.replaceResources.bind(kf8)
  kf8.replaceResources = (str) => replace(respellEmbeds(str))
  return kf8
}
