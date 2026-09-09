/**
 * The PalmDB container that every Kindle format is wrapped in.
 *
 * MOBI, AZW3 (KF8) and AZW4 are all a Palm Database file with different record
 * payloads and a different creator code. Building the container is the same
 * job each time, so it lives here once rather than three times.
 *
 * Layout, all big-endian:
 *
 *   0    32  name, NUL-padded, NUL-terminated
 *   32    2  attributes
 *   34    2  version
 *   36   12  creation / modification / last-backup dates
 *   48    4  modification number
 *   52    8  appInfo / sortInfo offsets (0 - we use neither)
 *   60    4  type      ('BOOK')
 *   64    4  creator   ('MOBI')
 *   68    4  unique-id seed
 *   72    4  next record list id (0)
 *   76    2  record count
 *   78   8n  record entries: offset(4), attributes(1), unique id(3)
 *   ...   2  padding, which readers expect and some require
 *   ...      record data, in order
 *
 * Every offset in the entry list is absolute from the start of the file. A list
 * that is one byte out yields a file that opens and shows nothing, which is why
 * the tests assert that each offset resolves to its own record's bytes rather
 * than merely that the numbers ascend.
 */

export const PALMDB_HEADER_BYTES = 78
export const RECORD_ENTRY_BYTES = 8
/** Readers expect two bytes of padding between the entry list and the data. */
const GAP_BYTES = 2

export interface PalmDbInput {
  /** Database name. 31 characters at most; it is NOT the book title. */
  name: string
  /** Four-character type, e.g. 'BOOK'. */
  type: string
  /** Four-character creator, e.g. 'MOBI'. */
  creator: string
  records: Buffer[]
}

/** Palm epoch is 1904; the format stores seconds since then, unsigned. */
function palmDate(now: Date): number {
  const seconds = Math.floor(now.getTime() / 1000) + 2082844800
  return seconds >>> 0
}

/**
 * A NUL is the field's terminator, so one inside the name truncates it. Replace
 * rather than strip, so the length a caller sees is the length written.
 */
function nameField(name: string): Buffer {
  const field = Buffer.alloc(32)
  const safe = name.replace(/\0/g, '_').slice(0, 31)
  field.write(safe, 0, 'latin1')
  return field
}

function fourCc(value: string, what: string): Buffer {
  const buf = Buffer.alloc(4, 0x20)
  if (value.length !== 4) throw new Error(`${what} must be exactly 4 characters (got "${value}")`)
  buf.write(value, 0, 'latin1')
  return buf
}

export function buildPalmDb({ name, type, creator, records }: PalmDbInput): Buffer {
  if (records.length === 0) {
    throw new Error('a PalmDB needs at least one record')
  }
  const header = Buffer.alloc(PALMDB_HEADER_BYTES)
  nameField(name).copy(header, 0)
  const date = palmDate(new Date())
  header.writeUInt32BE(date, 36) // creation
  header.writeUInt32BE(date, 40) // modification
  header.writeUInt32BE(0, 44) // last backup
  header.writeUInt32BE(0, 48) // modification number
  header.writeUInt32BE(0, 52) // appInfo
  header.writeUInt32BE(0, 56) // sortInfo
  fourCc(type, 'type').copy(header, 60)
  fourCc(creator, 'creator').copy(header, 64)
  header.writeUInt32BE(records.length * 2, 68) // unique-id seed
  header.writeUInt32BE(0, 72) // next record list id
  header.writeUInt16BE(records.length, 76)

  const entries = Buffer.alloc(records.length * RECORD_ENTRY_BYTES)
  let offset = PALMDB_HEADER_BYTES + entries.length + GAP_BYTES
  records.forEach((record, i) => {
    const at = i * RECORD_ENTRY_BYTES
    entries.writeUInt32BE(offset, at)
    entries.writeUInt8(0, at + 4) // attributes
    // Unique id, 3 bytes big-endian. Even ids by convention; any distinct set works.
    const id = i * 2
    entries.writeUInt8((id >> 16) & 0xff, at + 5)
    entries.writeUInt8((id >> 8) & 0xff, at + 6)
    entries.writeUInt8(id & 0xff, at + 7)
    offset += record.length
  })

  return Buffer.concat([header, entries, Buffer.alloc(GAP_BYTES), ...records])
}
