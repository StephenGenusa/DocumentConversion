import { describe, it, expect, vi, afterEach } from 'vitest'
import JSZip from 'jszip'
import {
  expandZipArchive,
  isUnsafeArchivePath,
  safeFilename,
  MAX_ARCHIVE_ENTRY_BYTES,
  MAX_ARCHIVE_TOTAL_BYTES,
} from '../../src/core/zip-expand'
import { detect } from '../../src/core/detect'

async function makeZip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>
}

/**
 * A zip bomb's whole point is that the declared size is enormous and the bytes
 * on disk are not, so the only honest test is one that fakes the declared size
 * and then asserts we never asked for the plaintext. Patching loadAsync lets us
 * do both without materialising gigabytes.
 */
function forgeDeclaredSizes(sizes: Record<string, number>): { asyncCalls: string[] } {
  const asyncCalls: string[] = []
  const real = JSZip.loadAsync.bind(JSZip)
  vi.spyOn(JSZip, 'loadAsync').mockImplementation(async (data: never, opts: never) => {
    const zip = await real(data, opts)
    for (const [name, file] of Object.entries(zip.files)) {
      const declared = sizes[name]
      const store = (file as unknown as { _data?: { uncompressedSize: number } })._data
      const honest = store?.uncompressedSize
      if (declared !== undefined && store) store.uncompressedSize = declared
      // The expander inflates through nodeStream, so that is what has to stay
      // uncalled. Watching `async` would pass trivially.
      const original = file.nodeStream.bind(file)
      file.nodeStream = ((type: never, cb: never) => {
        asyncCalls.push(name)
        // JSZip checks the inflated length against this field, so put the true
        // one back before handing over — the forgery is only there to be read
        // by the guard, exactly as a real bomb's lying header would be.
        if (store && honest !== undefined) store.uncompressedSize = honest
        return original(type, cb)
      }) as typeof file.nodeStream
    }
    return zip
  })
  return { asyncCalls }
}

afterEach(() => vi.restoreAllMocks())

describe('expandZipArchive', () => {
  it('returns file entries with their bytes', async () => {
    const bytes = await makeZip({ 'spec.md': '# Hello', 'notes/plan.txt': 'plain text' })
    const out = await expandZipArchive(bytes)
    expect(out.map((e) => e.filename).sort()).toEqual(['plan.txt', 'spec.md'])
    expect(out.find((e) => e.filename === 'spec.md')!.bytes.toString()).toBe('# Hello')
  })

  it('skips hidden and macOS junk entries', async () => {
    const bytes = await makeZip({
      'real.md': '# real',
      '__MACOSX/._real.md': 'junk',
      '.hidden': 'junk',
      'dir/.DS_Store': 'junk',
    })
    const out = await expandZipArchive(bytes)
    expect(out.map((e) => e.filename)).toEqual(['real.md'])
  })

  it('caps the number of entries at 100', async () => {
    const entries: Record<string, string> = {}
    for (let i = 0; i < 120; i++) entries[`f${i}.txt`] = `file ${i}`
    const out = await expandZipArchive(await makeZip(entries))
    expect(out).toHaveLength(100)
  })

  it('rejects non-zip bytes', async () => {
    await expect(expandZipArchive(Buffer.from('nope'))).rejects.toMatchObject({ code: 'read-failed' })
  })

  // ---- S3: path traversal ----

  const BS = String.fromCharCode(92) // a literal backslash, kept out of string escapes

  it('flattens backslash-separated entry names to their basename', async () => {
    const out = await expandZipArchive(await makeZip({ [`notes${BS}sub${BS}plan.txt`]: 'x' }))
    expect(out.map((e) => e.filename)).toEqual(['plan.txt'])
  })

  it('skips hidden entries hidden behind a backslash separator', async () => {
    const out = await expandZipArchive(await makeZip({ 'real.md': 'r', [`dir${BS}.DS_Store`]: 'junk' }))
    expect(out.map((e) => e.filename)).toEqual(['real.md'])
  })

  it('drops traversal, absolute and drive-letter entry names', async () => {
    // Note what is NOT in this list: '../../x'. JSZip collapses '..' itself on
    // load, but only across '/' — which is precisely why the backslash form
    // below reached us untouched, and why the guard cannot be left to it.
    const bytes = await makeZip({
      'good.txt': 'keep me',
      [`..${BS}..${BS}evil.txt`]: 'no',
      '/etc/passwd': 'no',
      [`C:${BS}Windows${BS}evil3.txt`]: 'no',
      [`${BS}${BS}server${BS}share${BS}evil4.txt`]: 'no',
    })
    const out = await expandZipArchive(bytes)
    expect(out.map((e) => e.filename)).toEqual(['good.txt'])
  })

  it('still refuses a dot-dot segment on its own account', () => {
    // Defence in depth: JSZip's own path resolution is not a guarantee we own.
    expect(isUnsafeArchivePath('../secret.txt')).toBe(true)
    expect(isUnsafeArchivePath(`..${BS}secret.txt`)).toBe(true)
    expect(isUnsafeArchivePath('notes/plan.txt')).toBe(false)
  })

  // ---- Windows-hostile basenames ----

  it('makes a Windows-reserved or device basename a plain filename', async () => {
    // `NUL.pdf` would "write" to the NUL device and report success; `a:b.pdf`
    // would land in an NTFS alternate data stream nobody can see.
    const out = await expandZipArchive(
      await makeZip({ 'NUL.txt': 'a', 'q?.txt': 'c', 'trail.': 'd', 'ok.txt': 'e' }),
    )
    expect(out.map((e) => e.filename).sort()).toEqual(['_NUL.txt', 'ok.txt', 'q_.txt', 'trail'])
  })

  it('safeFilename covers the device names, with and without an extension', () => {
    expect(safeFilename('con')).toBe('_con')
    expect(safeFilename('COM1.md')).toBe('_COM1.md')
    expect(safeFilename('console.md')).toBe('console.md') // a prefix is not a device
    expect(safeFilename('...')).toBe('_')
  })

  // ---- S4: zip bomb ----

  it('skips an entry whose declared size is over the cap without decompressing it', async () => {
    const probe = forgeDeclaredSizes({ 'bomb.txt': MAX_ARCHIVE_ENTRY_BYTES + 1 })
    const out = await expandZipArchive(await makeZip({ 'bomb.txt': 'tiny', 'ok.txt': 'fine' }))
    expect(out.map((e) => e.filename)).toEqual(['ok.txt'])
    expect(probe.asyncCalls).not.toContain('bomb.txt')
  })

  /**
   * The opposite lie. `forgeDeclaredSizes` above puts the honest size back
   * before inflation, so it can only ever see a header that lies UPWARD. A bomb
   * lies DOWNWARD — declares 100 bytes, holds 60 MB — and that has to be tested
   * against the real bytes, so patch the size fields in the archive itself.
   * Offset 24 in a central-directory record and 22 in a local header are the
   * uncompressed-size fields (APPNOTE 4.3.7, 4.3.12).
   */
  function lieAboutSize(zip: Buffer, entry: string, claim: number): Buffer {
    const out = Buffer.from(zip)
    // sizeAt / nameLenAt / headerLen: where the uncompressed size and the
    // filename length sit in each record, and how long its fixed part is.
    const patch = (sig: number[], sizeAt: number, nameLenAt: number, headerLen: number): void => {
      for (let i = out.indexOf(Buffer.from(sig)); i !== -1; i = out.indexOf(Buffer.from(sig), i + 4)) {
        const nameLen = out.readUInt16LE(i + nameLenAt)
        const name = out.subarray(i + headerLen, i + headerLen + nameLen).toString('utf8')
        if (name === entry) out.writeUInt32LE(claim, i + sizeAt)
      }
    }
    patch([0x50, 0x4b, 0x01, 0x02], 24, 28, 46)
    patch([0x50, 0x4b, 0x03, 0x04], 22, 26, 30)
    return out
  }

  const deflated = async (entries: Record<string, string | Buffer>): Promise<Buffer> => {
    const zip = new JSZip()
    for (const [name, content] of Object.entries(entries)) zip.file(name, content)
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as Promise<Buffer>
  }

  it('stops inflating an entry that lies downward about its size once it passes the cap', async () => {
    // 150 MB of zeros is ~150 KB deflated: the shape of a real bomb, at a size
    // a unit test can afford. Declared as 100 bytes it sails past the claim gate.
    const big = Buffer.alloc(3 * MAX_ARCHIVE_ENTRY_BYTES, 0)
    const lying = lieAboutSize(await deflated({ 'bomb.txt': big, 'ok.txt': 'fine' }), 'bomb.txt', 100)
    // Count what actually came out of the inflater. `nodeStream` is what the
    // expander reads through; a bounded reader must abandon the stream well
    // before it has produced the whole 150 MB.
    let inflated = 0
    const real = JSZip.loadAsync.bind(JSZip)
    vi.spyOn(JSZip, 'loadAsync').mockImplementation(async (data: never, opts: never) => {
      const zip = await real(data, opts)
      for (const file of Object.values(zip.files)) {
        const original = file.nodeStream.bind(file)
        file.nodeStream = ((type: never, cb: never) => {
          const stream = original(type, cb)
          stream.on('data', (chunk: Buffer) => (inflated += chunk.length))
          return stream
        }) as typeof file.nodeStream
      }
      return zip
    })
    const out = await expandZipArchive(lying)
    // The honest entry survives the dishonest one.
    expect(out.map((e) => e.filename)).toEqual(['ok.txt'])
    // pako inflates one 16 KB compressed block synchronously, and at deflate's
    // ~1032:1 ceiling that block is ~16.5 MB — so the stop lands within one block
    // of the cap. The unbounded path inflates all 150 MB.
    expect(inflated).toBeLessThan(MAX_ARCHIVE_ENTRY_BYTES + 17 * 1024 * 1024)
  }, 30_000)

  it('keeps the other entries when one entry fails to inflate', async () => {
    // Under the cap but still lying: JSZip's own length check fires at the end
    // of the stream. That is one bad entry, not a bad archive.
    const lying = lieAboutSize(await deflated({ 'bad.txt': 'x'.repeat(4096), 'ok.txt': 'fine' }), 'bad.txt', 100)
    const out = await expandZipArchive(lying)
    expect(out.map((e) => e.filename)).toEqual(['ok.txt'])
  })

  it('stops once the declared sizes add up past the archive-wide cap', async () => {
    const each = Math.floor(MAX_ARCHIVE_TOTAL_BYTES / 4)
    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']
    const sizes = Object.fromEntries(names.map((n) => [n, each]))
    const probe = forgeDeclaredSizes(sizes)
    const out = await expandZipArchive(await makeZip(Object.fromEntries(names.map((n) => [n, 'x']))))
    expect(out).toHaveLength(4)
    expect(probe.asyncCalls).not.toContain('e.txt')
  })
})

describe('phase-9 detection', () => {
  const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
  const zipWith = (marker: string) =>
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(marker, 'latin1')])

  it('routes CFB + .xls to the SheetJS reader', () => {
    expect(detect(CFB, 'old-report.xls')).toEqual({ kind: 'ok', format: 'xlsx' })
    expect(detect(CFB).kind).toBe('unsupported')
  })
  it('maps xls/ods/docm extensions', () => {
    expect(detect(Buffer.from('x'), 'a.ods')).toEqual({ kind: 'ok', format: 'xlsx' })
    expect(detect(CFB, 'a.xls')).toEqual({ kind: 'ok', format: 'xlsx' })
    expect(detect(Buffer.from('PK'), 'a.docm')).toEqual({ kind: 'ok', format: 'docx' })
  })
  it('sniffs ODF mimetypes to their readers', () => {
    expect(detect(zipWith('mimetypeapplication/vnd.oasis.opendocument.spreadsheet...'))).toEqual({
      kind: 'ok',
      format: 'xlsx',
    })
    expect(detect(zipWith('mimetypeapplication/vnd.oasis.opendocument.text...'))).toEqual({
      kind: 'ok',
      format: 'odt',
    })
    expect(detect(zipWith('mimetypeapplication/vnd.oasis.opendocument.presentation...'))).toEqual({
      kind: 'ok',
      format: 'odp',
    })
    // Formats with no reader still report themselves clearly.
    expect(detect(zipWith('mimetypeapplication/vnd.oasis.opendocument.graphics...')).kind).toBe('unsupported')
  })
  it('classifies other zips as archives instead of rejecting them', () => {
    expect(detect(zipWith('...some/entry.md...'))).toEqual({ kind: 'archive' })
  })
})
