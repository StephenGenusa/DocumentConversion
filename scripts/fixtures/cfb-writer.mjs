/**
 * A minimal writer for the Microsoft Compound File Binary format (MS-CFB),
 * just capable enough to produce a `.msg` that `@kenjiuno/msgreader` can
 * parse.
 *
 * Simplifications this reader's own code makes safe:
 *  - Every stream is padded to >= 4096 bytes (the Mini Stream cutoff used by
 *    `@kenjiuno/msgreader`'s `Reader.readProperty`), so nothing ever needs the
 *    Mini FAT / Mini Stream machinery. `sbatCount` stays 0.
 *  - Fewer than 109 FAT sectors are needed for a fixture this small, so no
 *    DIFAT (XBAT) sectors are needed either. `xbatCount` stays 0.
 *  - The directory "red-black tree" siblings only need to be A tree the
 *    reader's in-order walk can visit — not a balanced or colour-correct one.
 *    A right-only chain (each entry's `left` = NOSTREAM, `right` = next
 *    sibling) is a valid degenerate tree and the walk visits it in order.
 *
 * Sector size is the standard 512 bytes (CFB "major version 3").
 */

const SECTOR_SIZE = 512
const FREESECT = -1
const ENDOFCHAIN = -2
const FATSECT = -3
const NOSTREAM = -1

const STGTY_STORAGE = 1
const STGTY_STREAM = 2
const STGTY_ROOT = 5

/** @typedef {{ name: string, type: number, children?: Entry[], data?: Uint8Array }} Entry */

function utf16le(name) {
  const buf = Buffer.alloc(name.length * 2)
  buf.write(name, 0, 'utf16le')
  return buf
}

/** Pad a stream's bytes to the Mini Stream cutoff so it never needs the Mini FAT. */
function padToBigBlockMin(data) {
  const MIN = 4096
  if (data.length >= MIN) return data
  const out = Buffer.alloc(MIN)
  Buffer.from(data).copy(out)
  return out
}

function sectorsFor(byteLength) {
  return Math.max(1, Math.ceil(byteLength / SECTOR_SIZE))
}

/**
 * Lay out a directory tree into a flat property array (index 0 = Root Entry),
 * in the shape `@kenjiuno/msgreader`'s `Reader` expects.
 */
function flattenEntries(root) {
  /** @type {Entry[]} */
  const flat = []
  function visit(entry) {
    const index = flat.length
    flat.push(entry)
    entry._index = index
    for (const child of entry.children ?? []) visit(child)
    return index
  }
  visit(root)
  return flat
}

export function buildMsg(rootChildren) {
  const root = { name: 'Root Entry', type: STGTY_ROOT, children: rootChildren }
  const flat = flattenEntries(root)

  // Chain each storage's children as a right-leaning list (see file header comment).
  for (const entry of flat) {
    const kids = entry.children ?? []
    for (let i = 0; i < kids.length; i++) {
      kids[i]._left = NOSTREAM
      kids[i]._right = i + 1 < kids.length ? kids[i + 1]._index : NOSTREAM
    }
    entry._child = kids.length > 0 ? kids[0]._index : NOSTREAM
  }

  // --- Allocate sectors: directory sectors first, then one run per stream. ---
  const DIR_ENTRIES_PER_SECTOR = SECTOR_SIZE / 128
  const dirSectorCount = Math.ceil(flat.length / DIR_ENTRIES_PER_SECTOR)

  /** @type {{ startSector: number, sectorCount: number, data?: Buffer }[]} */
  const streamRuns = []
  let nextFree = dirSectorCount
  for (const entry of flat) {
    if (entry.type !== STGTY_STREAM) continue
    const data = padToBigBlockMin(Buffer.from(entry.data ?? new Uint8Array(0)))
    const count = sectorsFor(data.length)
    entry._startSector = nextFree
    entry._size = data.length
    streamRuns.push({ startSector: nextFree, sectorCount: count, data })
    nextFree += count
  }
  const dataSectorsEnd = nextFree
  // One or more FAT sectors, appended after the data.
  const totalChainedSectors = dataSectorsEnd // dir + streams, not counting FAT itself yet
  const fatEntriesPerSector = SECTOR_SIZE / 4
  let fatSectorCount = Math.ceil((totalChainedSectors + 8) / fatEntriesPerSector) // slack for FAT's own entries
  // Recompute once fatSectorCount's own sectors are added to the total (fixed point after 1 pass is enough here).
  for (let pass = 0; pass < 4; pass++) {
    const total = totalChainedSectors + fatSectorCount
    const needed = Math.ceil(total / fatEntriesPerSector)
    if (needed === fatSectorCount) break
    fatSectorCount = needed
  }
  const fatStart = dataSectorsEnd
  const totalSectors = dataSectorsEnd + fatSectorCount

  const fatArray = new Int32Array(fatSectorCount * fatEntriesPerSector).fill(FREESECT)

  // Directory sector chain.
  for (let s = 0; s < dirSectorCount; s++) fatArray[s] = s + 1 < dirSectorCount ? s + 1 : ENDOFCHAIN
  // Each stream's own sector chain.
  for (const run of streamRuns) {
    for (let i = 0; i < run.sectorCount; i++) {
      const sector = run.startSector + i
      fatArray[sector] = i + 1 < run.sectorCount ? sector + 1 : ENDOFCHAIN
    }
  }
  // FAT sectors mark themselves.
  for (let s = 0; s < fatSectorCount; s++) fatArray[fatStart + s] = FATSECT

  // --- Serialize. ---
  const buf = Buffer.alloc(SECTOR_SIZE * (1 + totalSectors))

  // Header.
  buf.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0) // signature
  buf.writeUInt16LE(0x003e, 24) // minor version
  buf.writeUInt16LE(0x0003, 26) // major version (512-byte sectors)
  buf.writeUInt16LE(0xfffe, 28) // byte order
  buf.writeUInt16LE(0x0009, 30) // sector shift -> 512
  buf.writeUInt16LE(0x0006, 32) // mini sector shift -> 64
  buf.writeUInt32LE(0, 40) // number of directory sectors (v3: unused, 0)
  buf.writeInt32LE(fatSectorCount, 44) // BAT_COUNT_OFFSET
  buf.writeInt32LE(0, 48) // PROPERTY_START_OFFSET -> first directory sector = 0
  buf.writeUInt32LE(0, 52) // transaction signature
  buf.writeUInt32LE(0x1000, 56) // mini stream cutoff
  buf.writeInt32LE(ENDOFCHAIN, 60) // SBAT_START_OFFSET: no mini FAT
  buf.writeInt32LE(0, 64) // SBAT_COUNT_OFFSET
  buf.writeInt32LE(ENDOFCHAIN, 68) // XBAT_START_OFFSET: no DIFAT sectors
  buf.writeInt32LE(0, 72) // XBAT_COUNT_OFFSET
  // DIFAT (109 slots): the FAT sector numbers themselves, then FREESECT/-1.
  for (let i = 0; i < 109; i++) {
    const value = i < fatSectorCount ? fatStart + i : FREESECT
    buf.writeInt32LE(value, 76 + i * 4)
  }

  const sectorOffset = (sector) => SECTOR_SIZE * (1 + sector)

  // Directory entries.
  for (const entry of flat) {
    const off = sectorOffset(0) + entry._index * 128
    const nameBuf = utf16le(entry.name)
    nameBuf.copy(buf, off, 0, Math.min(nameBuf.length, 62))
    buf.writeUInt16LE(Math.min(nameBuf.length, 62) + 2, off + 0x40) // name length incl. null terminator
    buf.writeUInt8(entry.type, off + 0x42)
    buf.writeUInt8(1, off + 0x43) // colour flag (unread by this reader)
    buf.writeInt32LE(entry._left ?? NOSTREAM, off + 0x44)
    buf.writeInt32LE(entry._right ?? NOSTREAM, off + 0x48)
    buf.writeInt32LE(entry._child ?? NOSTREAM, off + 0x4c)
    if (entry.type === STGTY_STREAM) {
      buf.writeInt32LE(entry._startSector, off + 0x74)
      buf.writeUInt32LE(entry._size, off + 0x78)
    } else {
      buf.writeInt32LE(entry.type === STGTY_ROOT ? (streamRuns[0]?.startSector ?? ENDOFCHAIN) : ENDOFCHAIN, off + 0x74)
      buf.writeUInt32LE(0, off + 0x78)
    }
  }
  // Root's startSector really should point at the mini-stream container; we
  // have none, so ENDOFCHAIN/size 0 is correct and harmless (readBigBlockTable
  // is only consulted by the small-block path, which nothing here uses).
  {
    const off = sectorOffset(0) + 0 * 128
    buf.writeInt32LE(ENDOFCHAIN, off + 0x74)
    buf.writeUInt32LE(0, off + 0x78)
  }

  // Stream data.
  for (const run of streamRuns) {
    run.data.copy(buf, sectorOffset(run.startSector))
  }

  // FAT sectors.
  for (let s = 0; s < fatSectorCount; s++) {
    const off = sectorOffset(fatStart + s)
    for (let i = 0; i < fatEntriesPerSector; i++) {
      buf.writeInt32LE(fatArray[s * fatEntriesPerSector + i] ?? FREESECT, off + i * 4)
    }
  }

  return buf
}

export const CFB = { STGTY_STORAGE, STGTY_STREAM, STGTY_ROOT }
