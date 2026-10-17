import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSqliteHost, defaultMemoryLimit, sharedBytes } from '../../src/main/sqlite-host'
import { sqliteReal } from '../../src/main/sqlite-cells'
import { createConverter } from '../../src/core/convert'
import { ConversionError } from '../../src/core/errors'
import type { ReadContext } from '../../src/core/types'

/**
 * The SQLite host for real: sql.js 1.14.2 in a worker_threads Worker, the
 * same worker script the app builds (bundled here with esbuild, as
 * electron-vite bundles it), loading the same wasm and loader the build
 * vendors into resources/sqlite. The test databases are made with sql.js too.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

const SQLJS = resolve('node_modules/sql.js/dist')
const require = createRequire(import.meta.url)

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void
  exec(sql: string, params?: unknown[]): { values: unknown[][] }[]
  export(): Uint8Array
  close(): void
}
// At the top, not in beforeAll: the describe blocks build their databases
// while the file is collected.
const SQL = await (require(join(SQLJS, 'sql-wasm.js')) as (o?: object) => Promise<{ Database: new (bytes?: Uint8Array) => SqlJsDatabase }>)()
let dir: string
let workerPath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docconv-sqlite-'))
  workerPath = join(dir, 'sqlite-worker.js')
  await build({
    entryPoints: [resolve('src/main/sqlite-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: workerPath,
    logLevel: 'silent',
  })
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A database built from statements, as file bytes. */
function makeDb(sql: string, fill?: (db: SqlJsDatabase) => void): Buffer {
  const db = new SQL.Database()
  db.run(sql)
  fill?.(db)
  const bytes = Buffer.from(db.export())
  db.close()
  return bytes
}

const render = async (): Promise<Buffer> => Buffer.from('%PDF-1.7 fake')
const host = (timeouts?: { print: number; export: number }) =>
  createSqliteHost({ workerPath, assetDir: SQLJS, ...(timeouts ? { timeouts } : {}) })
const converterWith = (h = host()) => createConverter(render, { sqlite: h })
const text = (r: { parts: { bytes: Buffer }[] }, i = 0) => r.parts[i].bytes.toString('utf8')

const ENDLESS = 'CREATE VIEW endless AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c'

describe('cells', () => {
  const bytes = makeDb(
    `CREATE TABLE cells(i INTEGER, r REAL, t TEXT, n, b BLOB);
     INSERT INTO cells VALUES (9223372036854775807, 0.1, 'Lamp', NULL, NULL);
     INSERT INTO cells VALUES (-9223372036854775808, 1.0, 'two
lines', NULL, NULL);
     INSERT INTO cells VALUES (42, 1e300, '', NULL, NULL);`,
    (db) => db.run('INSERT INTO cells VALUES (?, ?, ?, ?, ?)', [7, 2.5, 'blob row', null, new Uint8Array(1229)]),
  )

  it('keeps 64-bit integers exact, REAL as SQLite prints it, NULL empty, a BLOB as its size', async () => {
    const csv = text(await converterWith().convert({ bytes, filename: 'cells.db' }, 'sqlite', 'csv'))
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('i,r,t,n,b')
    expect(lines[1]).toBe('9223372036854775807,0.1,Lamp,,')
    expect(lines[2]).toBe('-9223372036854775808,1.0,"two\nlines",,')
    expect(lines[3]).toBe('42,1.0e+300,,,')
    expect(lines[4]).toBe('7,2.5,blob row,,[blob 1.2 KB]')
  })

  it('prints REAL the way SQLite does', () => {
    expect(sqliteReal(0.1 + 0.2)).toBe('0.3')
    expect(sqliteReal(1)).toBe('1.0')
    expect(sqliteReal(-0)).toBe('0.0')
    expect(sqliteReal(1e300)).toBe('1.0e+300')
    expect(sqliteReal(123456789012345680000)).toBe('1.23456789012346e+20')
    expect(sqliteReal(1e-7)).toBe('1.0e-07')
    expect(sqliteReal(100.5)).toBe('100.5')
    expect(sqliteReal(9e15)).toBe('9.0e+15')
    expect(sqliteReal(123456789012345)).toBe('123456789012345.0')
    expect(sqliteReal(0.0001)).toBe('0.0001')
    expect(sqliteReal(Infinity)).toBe('Inf')
    expect(sqliteReal(-Infinity)).toBe('-Inf')
  })

  it('agrees with SQLite\'s own CAST(x AS TEXT) across magnitudes', () => {
    const db = new SQL.Database()
    const values: number[] = [Infinity, -Infinity]
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let e = -320; e <= 308; e += 3) values.push((rand() - 0.5) * 10 ** e, 10 ** e, 9.999999999999999 * 10 ** e)
    for (let i = 0; i < 2000; i++) values.push((rand() - 0.5) * 10 ** Math.floor(rand() * 40 - 20))
    for (const v of values) {
      const [[cast]] = db.exec('SELECT CAST(CAST(? AS REAL) AS TEXT)', [v])[0].values as string[][]
      expect(sqliteReal(v), String(v)).toBe(cast)
    }
    db.close()
  })
})

describe('tables', () => {
  const bytes = makeDb(`
    CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO products(name) VALUES ('Lamp'), ('Desk');
    CREATE TABLE customers(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    INSERT INTO customers(name) VALUES ('Juno Halloway');
    CREATE TABLE empty_log(at TEXT, what TEXT);
    CREATE INDEX products_name ON products(name);
  `)

  it('prints the schema and every table, and leaves sqlite_sequence out', async () => {
    const hub = await converterWith().read({ bytes, filename: 'shop.sqlite' }, 'sqlite')
    const order = [...hub.html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])
    expect(order).toEqual(['Schema', 'customers', 'empty_log', 'products'])
    expect(hub.html).toContain('CREATE INDEX products_name ON products(name);')
    expect(hub.html).toContain('<td>1</td><td>Juno Halloway</td>')
    expect(hub.html).toContain('<h2>empty_log</h2>\n<table><thead><tr><th>at</th><th>what</th></tr></thead><tbody></tbody></table>')
    expect(hub.html).not.toContain('sqlite_sequence')
  })

  it('exports a table with no rows as its header', async () => {
    const csv = await converterWith().convert({ bytes, filename: 'shop.sqlite' }, 'sqlite', 'csv')
    expect(csv.parts.map((p) => p.suffix)).toEqual(['.customers', '.empty_log', '.products'])
    expect(text(csv, 1)).toBe('at,what\r\n')
    const xlsx = await converterWith().convert({ bytes, filename: 'shop.sqlite' }, 'sqlite', 'xlsx')
    expect(xlsx.parts[0].bytes.subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('quotes table names safely', async () => {
    const odd = makeDb(`
      CREATE TABLE "we""ird" (a); INSERT INTO "we""ird" VALUES ('quote');
      CREATE TABLE "has space" (a); INSERT INTO "has space" VALUES ('space');
      CREATE TABLE "[br]acket" (a); INSERT INTO "[br]acket" VALUES ('bracket');
      CREATE TABLE "x""; DROP TABLE keep; --" (a); INSERT INTO "x""; DROP TABLE keep; --" VALUES ('inject');
      CREATE TABLE keep (a); INSERT INTO keep VALUES ('kept');
    `)
    const h = host()
    const hub = await converterWith(h).read({ bytes: odd, filename: 'odd.db' }, 'sqlite')
    for (const v of ['quote', 'space', 'bracket', 'inject', 'kept']) expect(hub.html).toContain(`<td>${v}</td>`)
    expect(hub.html).toContain('<h2>we"ird</h2>')
    // Read again, in the other order of business: still all there.
    const csv = await converterWith(h).convert({ bytes: odd, filename: 'odd.db' }, 'sqlite', 'csv')
    expect(csv.parts).toHaveLength(5)
    expect(csv.parts.map((p) => p.bytes.toString('utf8')).join('')).toContain('kept')
  })
})

describe('6,000 rows', () => {
  const bytes = makeDb(`
    CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
    INSERT INTO items SELECT i, 'item ' || i FROM n;
  `)

  it('prints 5,000 with the limit message', async () => {
    const advice: string[] = []
    const conv = converterWith()
    const hub = await conv.read({ bytes, filename: 'items.db' }, 'sqlite', { onAdvice: (_k, m) => advice.push(m) })
    expect(hub.limited).toBe(true)
    expect(hub.html.match(/<tr>/g)).toHaveLength(5001)
    expect(hub.html).toContain('<td>5000</td>')
    expect(hub.html).not.toContain('<td>5001</td>')
    expect(hub.html).toContain('Showing the first 5,000 of 6,000 rows.')
    const out = await conv.convert({ bytes, filename: 'items.db' }, 'sqlite', 'html')
    expect(text(out)).toContain('Showing the first 5,000 of 6,000 rows.')
    expect(advice.join(' ')).toMatch(/5,000 of 6,000 rows/)
  })

  it('exports all 6,000 to CSV', async () => {
    const progress: string[] = []
    const csv = await converterWith().convert({ bytes, filename: 'items.db' }, 'sqlite', 'csv', undefined, {
      onProgress: (s) => progress.push(s),
    })
    const lines = text(csv).trim().split('\r\n')
    expect(lines).toHaveLength(6001)
    expect(lines[6000]).toBe('6000,item 6000')
  })
})

describe('views', () => {
  const bytes = makeDb(`
    CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, price REAL);
    INSERT INTO products(name, price) VALUES ('Lamp', 12.5), ('Desk', 140.0);
    CREATE VIEW cheap AS SELECT name FROM products WHERE price < 100;
    ${ENDLESS};
    CREATE VIEW zz_after AS SELECT name FROM products ORDER BY name;
  `)

  it('reports how many views a database has, for the card', async () => {
    expect(await host().viewCount(bytes)).toBe(3)
    expect(await host().viewCount(makeDb('CREATE TABLE t(a)'))).toBe(0)
    expect(await host().viewCount(Buffer.from('SQLite format 3\0garbage'))).toBe(0)
  })

  it('lists views in the schema only, by default', async () => {
    const hub = await converterWith().read({ bytes, filename: 'v.db' }, 'sqlite')
    expect(hub.html).toContain('CREATE VIEW cheap AS')
    expect(hub.html).not.toContain('<h2>cheap</h2>')
  })

  it('stops a view that runs too long, shows its SQL, and carries on', async () => {
    const h = host({ print: 300, export: 300 })
    const advice: string[] = []
    const t0 = Date.now()
    const hub = await converterWith(h).read({ bytes, filename: 'v.db' }, 'sqlite', {
      sqliteViews: true,
      onAdvice: (_k, m) => advice.push(m),
    })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(hub.html).toContain('<h2>cheap</h2>\n<table><thead><tr><th>name</th></tr></thead><tbody><tr><td>Lamp</td></tr></tbody></table>')
    expect(hub.html).toMatch(/<h2>endless<\/h2>\n<p><em>This view took longer than 0\.3 seconds and was stopped\.<\/em><\/p>\n<pre><code class="language-sql">CREATE VIEW endless AS WITH RECURSIVE/)
    // After the worker was replaced, the next view still read.
    expect(hub.html).toContain('<h2>zz_after</h2>\n<table><thead><tr><th>name</th></tr></thead><tbody><tr><td>Desk</td></tr><tr><td>Lamp</td></tr></tbody></table>')
    expect(advice.join(' ')).toMatch(/endless.*stopped/)
  })

  it('stops a view that runs too long when exporting, too', async () => {
    const advice: string[] = []
    const csv = await converterWith(host({ print: 300, export: 300 })).convert(
      { bytes, filename: 'v.db' },
      'sqlite',
      'csv',
      { read: { sqliteViews: true } },
      { onAdvice: (_k, m) => advice.push(m) },
    )
    expect(csv.parts.map((p) => p.suffix)).toEqual(['.products', '.cheap', '.endless', '.zz_after'])
    expect(text(csv, 3)).toBe('name\r\nDesk\r\nLamp\r\n')
    expect(advice.join(' ')).toMatch(/endless.*stopped/)
  })

  it('uses 10 s when printing and 60 s for table outputs, unless told otherwise', () => {
    expect(createSqliteHost({ workerPath, assetDir: SQLJS }).timeouts).toEqual({ print: 10_000, export: 60_000 })
  })
})

describe('cancel', () => {
  const bytes = makeDb(`CREATE TABLE t(a); INSERT INTO t VALUES (1); ${ENDLESS};`)

  it('terminates the worker and rejects as canceled', async () => {
    const ac = new AbortController()
    const ctx: ReadContext = { signal: ac.signal }
    setTimeout(() => ac.abort(), 300)
    const t0 = Date.now()
    const conv = converterWith(host({ print: 60_000, export: 60_000 }))
    const err = await conv.read({ bytes, filename: 'c.db' }, 'sqlite', { ...ctx, sqliteViews: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConversionError)
    expect((err as ConversionError).code).toBe('canceled')
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})

describe('bad files', () => {
  it('refuses garbage with the magic as encrypted or not a database', async () => {
    const garbage = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(4080, 7)])
    await expect(converterWith().read({ bytes: garbage, filename: 'x.db' }, 'sqlite')).rejects.toThrow(
      'This database is encrypted or not a SQLite database.',
    )
  })

  it('refuses an encrypted (headerless) .sqlite the same way', async () => {
    const encrypted = Buffer.from(Array.from({ length: 8192 }, (_v, i) => (i * 73 + 11) % 256))
    await expect(converterWith().convert({ bytes: encrypted, filename: 'locked.sqlite' }, 'sqlite', 'csv')).rejects.toThrow(
      'This database is encrypted or not a SQLite database.',
    )
  })

  it('gives the WAL notice for a WAL-mode database and still reads it', async () => {
    const bytes = makeDb(`CREATE TABLE t(a); INSERT INTO t VALUES ('in the file');`)
    bytes[18] = bytes[19] = 2
    const advice: string[] = []
    const hub = await converterWith().read({ bytes, filename: 'w.db' }, 'sqlite', { onAdvice: (_k, m) => advice.push(m) })
    expect(hub.html).toContain('<td>in the file</td>')
    expect(advice.join(' ')).toMatch(/WAL mode/)
  })
})

describe('memory', () => {
  const MB = 1048576
  // A view whose ORDER BY holds every row at once: 200,000 rows of 1,000 random bytes, about 200 MB to sort.
  const ROWS = 200_000
  const HUNGRY = `CREATE VIEW hungry AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT ${ROWS}) SELECT x, randomblob(1000) AS b FROM c ORDER BY b`
  const bytes = makeDb(`CREATE TABLE t(a); INSERT INTO t VALUES ('kept'); ${HUNGRY}; CREATE VIEW small AS SELECT a FROM t ORDER BY a;`)
  const small = (): ReturnType<typeof createSqliteHost> => createSqliteHost({ workerPath, assetDir: SQLJS, memoryLimit: 32 * MB })

  it('stops a view that needs more than the limit, in words, and reads the rest', async () => {
    const advice: string[] = []
    const out = await createConverter(render, { sqlite: small() }).convert(
      { bytes, filename: 'm.db' },
      'sqlite',
      'csv',
      { read: { sqliteViews: true } },
      { onAdvice: (_k, m) => advice.push(m) },
    )
    expect(advice.join(' ')).toContain('The view "hungry" could not be read: it needs more than 32 MB of memory, the most a database is given.')
    const bySuffix = Object.fromEntries(out.parts.map((p) => [p.suffix, p.bytes.toString('utf8')]))
    expect(bySuffix['.t']).toBe('a\r\nkept\r\n')
    // Read after the one that ran out, by a fresh engine.
    expect(bySuffix['.small']).toBe('a\r\nkept\r\n')
  })

  it('reads the same view with the memory it needs', async () => {
    const advice: string[] = []
    const out = await createConverter(render, { sqlite: createSqliteHost({ workerPath, assetDir: SQLJS, memoryLimit: 512 * MB }) }).convert(
      { bytes, filename: 'm.db' },
      'sqlite',
      'csv',
      { read: { sqliteViews: true } },
      { onAdvice: (_k, m) => advice.push(m) },
    )
    expect(advice).toEqual([])
    expect(out.parts.find((p) => p.suffix === '.hungry')!.bytes.toString('utf8').split('\r\n').length).toBe(ROWS + 2)
  })

  it('gives a database a quarter of the machine, from 256 MB to 1.5 GB', () => {
    expect(defaultMemoryLimit(512 * MB)).toBe(256 * MB)
    expect(defaultMemoryLimit(4096 * MB)).toBe(1024 * MB)
    expect(defaultMemoryLimit(65536 * MB)).toBe(1536 * MB)
  })
})

describe('a large database', () => {
  it('is handed to each worker as shared memory, not copied into it', () => {
    // Electron's main process crashed outright cloning a database of 1.1 GB
    // or more into a worker's workerData; shared memory is not cloned.
    const bytes = Buffer.from([1, 2, 3, 4])
    const shared = sharedBytes(bytes)
    expect(shared.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect([...shared]).toEqual([1, 2, 3, 4])
  })
})

describe('the original file', () => {
  it('is never written: bytes and mtime unchanged, and no -wal or -journal beside it', async () => {
    const sub = await mkdtemp(join(dir, 'orig-'))
    const path = join(sub, 'keep.sqlite')
    const bytes = makeDb(`CREATE TABLE t(a); INSERT INTO t VALUES (1), (2); CREATE VIEW v AS SELECT a FROM t;`)
    bytes[18] = bytes[19] = 2
    await writeFile(path, bytes)
    const before = await stat(path)
    const conv = converterWith()
    const read = await readFile(path)
    await conv.convert({ bytes: read, filename: 'keep.sqlite' }, 'sqlite', 'html', { read: { sqliteViews: true } })
    await conv.convert({ bytes: read, filename: 'keep.sqlite' }, 'sqlite', 'csv', { read: { sqliteViews: true } })
    const after = await stat(path)
    expect((await readFile(path)).equals(bytes)).toBe(true)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(await readdir(sub)).toEqual(['keep.sqlite'])
  })
})
