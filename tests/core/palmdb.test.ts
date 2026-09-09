import { describe, it, expect } from 'vitest'
import { buildPalmDb, PALMDB_HEADER_BYTES, RECORD_ENTRY_BYTES } from '../../src/core/writers/palmdb'

const rec = (n: number, byte = 0x41): Buffer => Buffer.alloc(n, byte)

/**
 * The container all three Kindle formats share. Pure byte assembly, so it is
 * testable with no document at all - and worth testing exhaustively, because
 * every field here is an offset something else resolves through. A record list
 * that is one byte out produces a file that opens and shows nothing.
 */
describe('buildPalmDb', () => {
  const db = (records: Buffer[], name = 'Test Book') =>
    buildPalmDb({ name, type: 'BOOK', creator: 'MOBI', records })

  it('starts with the 32-byte NUL-padded name', () => {
    const out = db([rec(4)])
    expect(out.subarray(0, 9).toString('latin1')).toBe('Test Book')
    expect(out.subarray(9, 32).every((b) => b === 0)).toBe(true)
  })

  it('writes the type and creator where readers look for them', () => {
    const out = db([rec(4)])
    expect(out.subarray(60, 64).toString('latin1')).toBe('BOOK')
    expect(out.subarray(64, 68).toString('latin1')).toBe('MOBI')
  })

  it('declares the record count it actually wrote', () => {
    const out = db([rec(4), rec(8), rec(16)])
    expect(out.readUInt16BE(76)).toBe(3)
  })

  it('gives every record an offset that resolves to its own bytes', () => {
    const records = [rec(4, 0x41), rec(8, 0x42), rec(16, 0x43)]
    const out = db(records)
    for (let i = 0; i < records.length; i++) {
      const offset = out.readUInt32BE(PALMDB_HEADER_BYTES + i * RECORD_ENTRY_BYTES)
      expect(out.subarray(offset, offset + records[i].length)).toEqual(records[i])
    }
  })

  it('orders offsets strictly ascending, which readers rely on for length', () => {
    const out = db([rec(4), rec(8), rec(16)])
    const offsets = [0, 1, 2].map((i) => out.readUInt32BE(PALMDB_HEADER_BYTES + i * RECORD_ENTRY_BYTES))
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
    expect(new Set(offsets).size).toBe(3)
  })

  it('gives each record a unique id', () => {
    const out = db([rec(4), rec(8), rec(16)])
    const ids = [0, 1, 2].map((i) => {
      const at = PALMDB_HEADER_BYTES + i * RECORD_ENTRY_BYTES + 5
      return (out[at] << 16) | (out[at + 1] << 8) | out[at + 2]
    })
    expect(new Set(ids).size).toBe(3)
  })

  it('truncates an over-long name rather than overrunning the field', () => {
    const out = buildPalmDb({ name: 'x'.repeat(100), type: 'BOOK', creator: 'MOBI', records: [rec(4)] })
    expect(out.subarray(0, 32).toString('latin1')).toBe('x'.repeat(31) + '\0')
    expect(out.subarray(60, 64).toString('latin1')).toBe('BOOK')
  })

  it('replaces NULs in a name rather than terminating the field early', () => {
    const out = buildPalmDb({ name: 'a\0b', type: 'BOOK', creator: 'MOBI', records: [rec(4)] })
    expect(out.subarray(0, 3).toString('latin1')).toBe('a_b')
  })

  it('refuses to build a database with no records', () => {
    expect(() => db([])).toThrow()
  })

  it('is exactly as long as its parts', () => {
    const records = [rec(4), rec(8), rec(16)]
    const out = db(records)
    expect(out.length).toBe(PALMDB_HEADER_BYTES + 3 * RECORD_ENTRY_BYTES + 2 + 4 + 8 + 16)
  })
})
