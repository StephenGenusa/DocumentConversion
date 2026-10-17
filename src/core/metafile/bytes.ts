/*
 * A bounded little-endian view of part of a metafile: every read is checked
 * against the view's own end, so a record that claims more than it holds
 * stops at its last byte (ShortRecord) instead of reading its neighbor's
 * bytes, or past the file.
 */

/** A read past the end of a view: the record it belongs to is skipped. */
export class ShortRecord extends Error {
  constructor() {
    super('the record is shorter than it says')
  }
}

export class View {
  constructor(
    readonly buf: Buffer,
    readonly start: number,
    readonly end: number,
  ) {}

  get length(): number {
    return this.end - this.start
  }

  /** Whether `n` bytes at `at` (from the view's start) are all in the view. */
  has(at: number, n: number): boolean {
    return Number.isSafeInteger(at) && Number.isSafeInteger(n) && at >= 0 && n >= 0 && this.start + at + n <= this.end
  }

  private pos(at: number, n: number): number {
    if (!this.has(at, n)) throw new ShortRecord()
    return this.start + at
  }

  u8(at: number): number {
    return this.buf[this.pos(at, 1)]
  }
  u16(at: number): number {
    return this.buf.readUInt16LE(this.pos(at, 2))
  }
  i16(at: number): number {
    return this.buf.readInt16LE(this.pos(at, 2))
  }
  u32(at: number): number {
    return this.buf.readUInt32LE(this.pos(at, 4))
  }
  i32(at: number): number {
    return this.buf.readInt32LE(this.pos(at, 4))
  }
  /** A 32-bit float; NaN and the infinities are ShortRecord too: no drawing uses them. */
  f32(at: number): number {
    const v = this.buf.readFloatLE(this.pos(at, 4))
    if (!Number.isFinite(v)) throw new ShortRecord()
    return v
  }

  /** `n` bytes at `at`, as a view of their own. */
  sub(at: number, n: number): View {
    const p = this.pos(at, n)
    return new View(this.buf, p, p + n)
  }

  /** The bytes from `at` to the end of the view. */
  rest(at: number): View {
    return this.sub(at, Math.max(0, this.length - at))
  }

  /** `n` bytes at `at`, shared with the file (not copied). */
  bytes(at: number, n: number): Buffer {
    const p = this.pos(at, n)
    return this.buf.subarray(p, p + n)
  }

  /** `chars` UTF-16LE code units at `at`. */
  utf16(at: number, chars: number): string {
    const p = this.pos(at, chars * 2)
    return this.buf.toString('utf16le', p, p + chars * 2)
  }
}
