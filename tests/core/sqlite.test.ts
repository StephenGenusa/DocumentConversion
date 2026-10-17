import { describe, it, expect } from 'vitest'
import { detect } from '../../src/core/detect'
import { createConverter } from '../../src/core/convert'
import { ConversionError } from '../../src/core/errors'
import { SQLITE_ENCRYPTED_MESSAGE, SqliteTimeoutError, type SqliteDatabase, type SqliteEngine, type SqliteObject } from '../../src/core/sqlite'
import { checkFlagScope, parseArgs, USAGE } from '../../src/cli/args'
import { cliConvertOptions } from '../../src/cli/options'
import { DEFAULT_SETTINGS } from '../../src/core/settings'
import type { ReadContext } from '../../src/core/types'

/**
 * The SQLite reader against a fake engine (ConverterDeps.sqlite). The real
 * engine, sql.js in a worker, is tested in tests/main/sqlite-host.test.ts;
 * here only what core does with its answers.
 */

interface FakeTable {
  type: 'table' | 'view'
  sql: string
  columns: string[]
  rows: string[][]
  /** A view that never finishes: every query of it times out. */
  hangs?: boolean
}

interface FakeLog {
  opened: { purpose: string }[]
  closed: number
}

function fakeEngine(objects: Record<string, FakeTable>, opts: { garbage?: boolean; extra?: SqliteObject[] } = {}): SqliteEngine & { log: FakeLog } {
  const log: FakeLog = { opened: [], closed: 0 }
  const get = (name: string): FakeTable => {
    const t = objects[name]
    if (!t) throw new Error(`no such table: ${name}`)
    if (t.hangs) throw new SqliteTimeoutError(name, 10)
    return t
  }
  return {
    log,
    async open(_bytes, o) {
      log.opened.push({ purpose: o.purpose })
      const db: SqliteDatabase = {
        async schema() {
          if (opts.garbage) throw new Error('file is not a database')
          const own = Object.entries(objects).map(([name, t]) => ({ type: t.type, name, sql: t.sql }))
          return [...own, ...(opts.extra ?? [])]
        },
        async columns(name) {
          return objects[name].columns
        },
        async count(name) {
          return get(name).rows.length
        },
        async *rows(name, ro) {
          const t = get(name)
          yield* ro?.limit !== undefined ? t.rows.slice(0, ro.limit) : t.rows
        },
        async close() {
          log.closed++
        },
      }
      return db
    },
  }
}

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1')
/** A database's first bytes: the header, WAL mode or not. */
function header(wal = false): Buffer {
  const b = Buffer.alloc(100)
  MAGIC.copy(b)
  b[18] = b[19] = wal ? 2 : 1
  return b
}
const src = (bytes = header(), filename = 'shop.sqlite') => ({ bytes, filename })
const render = async (): Promise<Buffer> => Buffer.from('%PDF-1.7 fake')

const shop: Record<string, FakeTable> = {
  products: {
    type: 'table',
    sql: 'CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT)',
    columns: ['id', 'name'],
    rows: [
      ['1', 'Lamp'],
      ['2', 'Desk'],
    ],
  },
  customers: {
    type: 'table',
    sql: 'CREATE TABLE customers(id INTEGER, name TEXT, email TEXT)',
    columns: ['id', 'name', 'email'],
    rows: [['1', 'Petra Ferrow', 'petra@example.com']],
  },
  empty_log: { type: 'table', sql: 'CREATE TABLE empty_log(at TEXT, what TEXT)', columns: ['at', 'what'], rows: [] },
  cheap: { type: 'view', sql: 'CREATE VIEW cheap AS SELECT * FROM products', columns: ['id', 'name'], rows: [['1', 'Lamp']] },
}

const html = async (engine: SqliteEngine | undefined, ctx: ReadContext = {}, bytes = header()) => {
  const conv = createConverter(render, engine ? { sqlite: engine } : {})
  return conv.read(src(bytes), 'sqlite', ctx)
}

describe('detecting SQLite', () => {
  it('goes by the magic bytes, whatever the extension', () => {
    for (const name of ['a.sqlite', 'a.sqlite3', 'a.db', 'a.db3', 'a.bin', 'noext', 'a.txt', 'a.docx', undefined]) {
      const d = detect(header(), name)
      expect(d.kind === 'ok' && d.format, String(name)).toBe('sqlite')
    }
  })

  it('does not read a .db without the magic as SQLite', () => {
    const d = detect(Buffer.from('just some notes\n'), 'notes.db')
    expect(d.kind === 'ok' && d.format).toBe('txt')
  })

  it('lets a PDF named .sqlite be a PDF', () => {
    const d = detect(Buffer.from('%PDF-1.7\n'), 'x.sqlite')
    expect(d.kind === 'ok' && d.format).toBe('pdf')
  })

  it('reads a .sqlite without the magic as SQLite, so it fails with the encrypted message', async () => {
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_v, i) => (i * 73 + 11) % 256))
    const d = detect(bytes, 'locked.sqlite')
    expect(d.kind === 'ok' && d.format).toBe('sqlite')
  })
})

describe('the SQLite reader', () => {
  it('needs the desktop app', async () => {
    const conv = createConverter(render)
    await expect(conv.read(src(), 'sqlite')).rejects.toThrow(/^SQLite databases need the desktop app$/)
    await expect(conv.convert(src(), 'sqlite', 'csv')).rejects.toThrow(/^SQLite databases need the desktop app$/)
  })

  it('prints the schema, then every table by name', async () => {
    const engine = fakeEngine(shop)
    const hub = await html(engine)
    expect(hub.title).toBe('shop.sqlite')
    expect(hub.html).toMatch(/^<h1>shop\.sqlite<\/h1>/)
    expect(hub.html).toContain('<h2>Schema</h2>')
    expect(hub.html).toMatch(/<pre><code class="language-sql">CREATE TABLE products[\s\S]*CREATE VIEW cheap AS SELECT \* FROM products;<\/code><\/pre>/)
    const order = [...hub.html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])
    expect(order).toEqual(['Schema', 'customers', 'empty_log', 'products'])
    expect(hub.html).toContain('<td>Petra Ferrow</td><td>petra@example.com</td>')
    expect(engine.log.opened).toEqual([{ purpose: 'print' }])
    expect(engine.log.closed).toBe(1)
  })

  it('prints a table with no rows as its header', async () => {
    const hub = await html(fakeEngine(shop))
    expect(hub.html).toContain('<h2>empty_log</h2>\n<table><thead><tr><th>at</th><th>what</th></tr></thead><tbody></tbody></table>')
  })

  it('leaves internal sqlite_ tables out', async () => {
    const extra: SqliteObject[] = [{ type: 'table', name: 'sqlite_sequence', sql: 'CREATE TABLE sqlite_sequence(name,seq)' }]
    const hub = await html(fakeEngine(shop, { extra }))
    expect(hub.html).not.toContain('sqlite_sequence')
  })

  it('lists views in the schema only, unless view results are included', async () => {
    const off = await html(fakeEngine(shop))
    expect(off.html).toContain('CREATE VIEW cheap')
    expect(off.html).not.toContain('<h2>cheap</h2>')
    const on = await html(fakeEngine(shop), { sqliteViews: true })
    const order = [...on.html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])
    expect(order).toEqual(['Schema', 'customers', 'empty_log', 'products', 'cheap'])
  })

  it('shows a view that times out as its SQL and a notice, and carries on', async () => {
    const slow: Record<string, FakeTable> = {
      ...shop,
      a_endless: { type: 'view', sql: 'CREATE VIEW a_endless AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c', columns: ['x'], rows: [], hangs: true },
    }
    const advice: string[] = []
    const hub = await html(fakeEngine(slow), { sqliteViews: true, onAdvice: (_k, m) => advice.push(m) })
    expect(hub.html).toMatch(/<h2>a_endless<\/h2>\n<p><em>This view took longer than 10 seconds and was stopped\.<\/em><\/p>\n<pre><code class="language-sql">CREATE VIEW a_endless AS WITH RECURSIVE/)
    // The view after it still came out.
    expect(hub.html).toContain('<h2>cheap</h2>\n<table>')
    expect(advice.join(' ')).toMatch(/a_endless.*stopped/)
  })

  it('says when the database is in WAL mode', async () => {
    const advice: string[] = []
    const hub = await html(fakeEngine(shop), { onAdvice: (_k, m) => advice.push(m) }, header(true))
    expect(advice.join(' ')).toMatch(/WAL mode.*-wal/)
    expect(hub.html).toMatch(/WAL mode/)
    const plain: string[] = []
    await html(fakeEngine(shop), { onAdvice: (_k, m) => plain.push(m) })
    expect(plain.join(' ')).not.toMatch(/WAL/)
  })

  it('refuses an encrypted or garbage database with one message', async () => {
    const engine = fakeEngine(shop, { garbage: true })
    await expect(html(engine)).rejects.toThrow(SQLITE_ENCRYPTED_MESSAGE)
    expect(SQLITE_ENCRYPTED_MESSAGE).toBe('This database is encrypted or not a SQLite database.')
    expect(engine.log.closed).toBe(1)
    const conv = createConverter(render, { sqlite: engine })
    await expect(conv.convert(src(), 'sqlite', 'csv')).rejects.toBeInstanceOf(ConversionError)
  })

  it('refuses a file over 200 MB before opening it', async () => {
    const engine = fakeEngine(shop)
    const big = Buffer.alloc(200 * 1024 * 1024 + 1)
    header().copy(big)
    await expect(html(engine, {}, big)).rejects.toThrow(/over the 200 MB limit/)
    expect(engine.log.opened).toHaveLength(0)
  })
})

describe('6,000 rows', () => {
  const rows = Array.from({ length: 6000 }, (_v, i) => [String(i + 1), `item ${i + 1}`])
  const big: Record<string, FakeTable> = { items: { type: 'table', sql: 'CREATE TABLE items(id, label)', columns: ['id', 'label'], rows } }

  it('prints 5,000 and says so', async () => {
    const advice: string[] = []
    const hub = await html(fakeEngine(big), { onAdvice: (_k, m) => advice.push(m) })
    expect(hub.limited).toBe(true)
    expect(hub.html.match(/<tr>/g)).toHaveLength(5001)
    expect(hub.html).toContain('Showing the first 5,000 of 6,000 rows.')
    expect(advice.join(' ')).toMatch(/items.*5,000 of 6,000 rows/)
  })

  it('exports all 6,000 to CSV, without the hub', async () => {
    const engine = fakeEngine(big)
    const conv = createConverter(render, { sqlite: engine })
    const csv = await conv.convert(src(), 'sqlite', 'csv')
    const lines = csv.parts[0].bytes.toString('utf8').trim().split('\r\n')
    expect(lines).toHaveLength(6001)
    expect(lines[0]).toBe('id,label')
    expect(engine.log.opened).toEqual([{ purpose: 'export' }])
    expect(engine.log.closed).toBe(1)
  })
})

describe('exporting', () => {
  it('writes one file per table, and a header-only file for an empty table', async () => {
    const conv = createConverter(render, { sqlite: fakeEngine(shop) })
    const csv = await conv.convert(src(), 'sqlite', 'csv')
    expect(csv.parts.map((p) => p.suffix)).toEqual(['.customers', '.empty_log', '.products'])
    expect(csv.parts[1].bytes.toString('utf8')).toBe('at,what\r\n')
  })

  it('adds the views when they are included', async () => {
    const conv = createConverter(render, { sqlite: fakeEngine(shop) })
    const csv = await conv.convert(src(), 'sqlite', 'csv', { read: { sqliteViews: true } })
    expect(csv.parts.map((p) => p.suffix)).toEqual(['.customers', '.empty_log', '.products', '.cheap'])
  })

  it('stops a view that times out, says so, and writes the rest', async () => {
    const slow: Record<string, FakeTable> = {
      ...shop,
      endless: { type: 'view', sql: 'CREATE VIEW endless AS SELECT 1', columns: ['x'], rows: [], hangs: true },
    }
    const advice: string[] = []
    const conv = createConverter(render, { sqlite: fakeEngine(slow) })
    const csv = await conv.convert(src(), 'sqlite', 'csv', { read: { sqliteViews: true } }, { onAdvice: (_k, m) => advice.push(m) })
    expect(csv.parts.map((p) => p.suffix)).toEqual(['.customers', '.empty_log', '.products', '.cheap', '.endless'])
    expect(csv.parts[4].bytes.toString('utf8')).toBe('x\r\n')
    expect(advice.join(' ')).toMatch(/endless.*stopped/)
  })
})

describe('--sqlite-views', () => {
  it('includes view results for every input', () => {
    const r = parseArgs(['a.sqlite', '--to', 'csv', '--sqlite-views'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(cliConvertOptions(DEFAULT_SETTINGS, r.req, () => true)).toMatchObject({ options: { read: { sqliteViews: true } } })
    expect(USAGE).toContain('--sqlite-views')
  })

  it('is a usage error when no input is a database', () => {
    expect(checkFlagScope(['--sqlite-views'], 'csv', ['md'])).toMatch(/--sqlite-views applies only to sqlite input/)
    expect(checkFlagScope(['--sqlite-views'], 'csv', ['md', 'sqlite'])).toBeNull()
  })
})
