import { createInflateRaw } from 'node:zlib'

/*
 * Searching a few parts of a zip package without opening the rest of it: the
 * central directory says where each part is, and only the parts asked for
 * are inflated, a chunk at a time, stopping at the first match. A Word file
 * of 160 MB of pictures is answered from its document.xml alone.
 */

interface Part {
  method: number
  start: number
  end: number
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/**
 * Where each of `names` is stored, or undefined when the bytes are not a
 * zip this can read without help: no end record, a ZIP64 one, an encrypted
 * part, or a record that points outside the file. A name the package does
 * not hold is simply absent from the map.
 */
function locate(bytes: Buffer, names: ReadonlySet<string>): Map<string, Part> | undefined {
  const min = Math.max(0, bytes.length - 22 - 0xffff)
  let eocd = -1
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return undefined
  const count = bytes.readUInt16LE(eocd + 10)
  const size = bytes.readUInt32LE(eocd + 12)
  const offset = bytes.readUInt32LE(eocd + 16)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size > bytes.length) return undefined
  const parts = new Map<string, Part>()
  for (let p = offset, n = 0; n < count; n++) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== CENTRAL) return undefined
    const flags = bytes.readUInt16LE(p + 8)
    const method = bytes.readUInt16LE(p + 10)
    const compressed = bytes.readUInt32LE(p + 20)
    const nameLength = bytes.readUInt16LE(p + 28)
    const extraLength = bytes.readUInt16LE(p + 30)
    const commentLength = bytes.readUInt16LE(p + 32)
    const local = bytes.readUInt32LE(p + 42)
    const name = bytes.toString('utf8', p + 46, p + 46 + nameLength)
    p += 46 + nameLength + extraLength + commentLength
    if (!names.has(name)) continue
    if (flags & 1 || compressed === 0xffffffff || local === 0xffffffff) return undefined
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOCAL) return undefined
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (start + compressed > bytes.length) return undefined
    parts.set(name, { method, start, end: start + compressed })
  }
  return parts
}

/** A match straddling two chunks is found: this much of the last one is kept. */
const OVERLAP = 256

/** Whether one stored or deflated part's text matches `pattern`; undefined if it cannot be read or time ran out. */
function partMatches(bytes: Buffer, part: Part, pattern: RegExp, deadline: number): Promise<boolean | undefined> {
  if (part.method === 0) return Promise.resolve(pattern.test(bytes.toString('latin1', part.start, part.end)))
  if (part.method !== 8) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const inflate = createInflateRaw()
    let tail = ''
    let settled = false
    const settle = (answer: boolean | undefined): void => {
      if (settled) return
      settled = true
      inflate.destroy()
      resolve(answer)
    }
    inflate.on('data', (chunk: Buffer) => {
      // Latin-1 keeps every byte one character: the markup searched for is ASCII.
      const text = tail + chunk.toString('latin1')
      if (pattern.test(text)) settle(true)
      else if (performance.now() > deadline) settle(undefined)
      else tail = text.slice(-OVERLAP)
    })
    inflate.on('end', () => settle(false))
    inflate.on('error', () => settle(undefined))
    inflate.end(bytes.subarray(part.start, part.end))
  })
}

/**
 * Whether any of the named parts matches `pattern` (true), none does
 * (false, with `names[0]` present), or the question has no answer here
 * (undefined: not a zip this reads, `names[0]` missing, a part unreadable,
 * or `deadline`, a `performance.now()` time, passed).
 */
export async function zipPartsMatch(bytes: Buffer, names: readonly string[], pattern: RegExp, deadline: number): Promise<boolean | undefined> {
  const parts = locate(bytes, new Set(names))
  if (!parts || !parts.has(names[0])) return undefined
  for (const name of names) {
    const part = parts.get(name)
    if (!part) continue
    const found = await partMatches(bytes, part, pattern, deadline)
    if (found !== false) return found
  }
  return false
}
