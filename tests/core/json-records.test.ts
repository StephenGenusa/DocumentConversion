import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { reindentJson, needsReformat } from '../../src/core/json-tokens'
import { reindentXml } from '../../src/core/xml-indent'
import { readJson, readJsonRows } from '../../src/core/readers/json'
import { readCode } from '../../src/core/readers/code'
import { writeRows } from '../../src/core/writers/rows'
import { detect } from '../../src/core/detect'
import { MAX_RECORD_SOURCE_BYTES, PRINT_RECORD_LIMIT, type RowSource } from '../../src/core/records'
import { checkFlagScope, parseArgs } from '../../src/cli/args'

const src = (text: string, filename: string) => ({ bytes: Buffer.from(text, 'utf8'), filename })
const collect = async (rows: RowSource['rows']): Promise<string[][]> => {
  const out: string[][] = []
  for await (const r of rows) out.push(r)
  return out
}

describe('lossless JSON re-indenting', () => {
  it('keeps every number, string and key exactly as written', () => {
    const text = '{"big":12345678901234567890,"f":1.0,"e":1e5,"s":"caf\\u00e9","dup":1,"dup":2,"neg":-0}'
    expect(reindentJson(text)).toBe(
      '{\n  "big": 12345678901234567890,\n  "f": 1.0,\n  "e": 1e5,\n  "s": "caf\\u00e9",\n  "dup": 1,\n  "dup": 2,\n  "neg": -0\n}',
    )
  })

  it('keeps empty containers compact, and nests arrays', () => {
    expect(reindentJson('{"a":[],"b":{},"c":[1,[2,3]]}')).toBe('{\n  "a": [],\n  "b": {},\n  "c": [\n    1,\n    [\n      2,\n      3\n    ]\n  ]\n}')
  })

  it('keeps JSONC comments', () => {
    expect(reindentJson('{// first\n"a":1,/* block */"b":2}')).toBe('{\n  // first\n  "a": 1,\n  /* block */\n  "b": 2\n}')
  })

  it('survives deep nesting without recursion', () => {
    const deep = '['.repeat(10000) + ']'.repeat(10000)
    expect(reindentJson(deep)?.split('\n').length).toBe(19999)
  })

  it('returns null for something that is not JSON, so the original is kept', () => {
    expect(reindentJson('{"a":1')).toBeNull()
    expect(reindentJson('{"a": tru e}')).toBeNull() // two values with nothing between: not JSON
    expect(reindentJson('{"a": undefined}')).not.toBeNull() // a bare word is passed through, not judged
    expect(reindentJson('{"a":"unterminated}')).toBeNull()
    expect(reindentJson('}{')).toBeNull()
  })

  it('reformats only a file that cannot be read as written', () => {
    expect(needsReformat('{"a":1}')).toBe(false)
    expect(needsReformat(JSON.stringify({ k: 'x'.repeat(300) }))).toBe(true)
    expect(needsReformat('{\n' + '  "k": "' + 'x'.repeat(520) + '"\n}')).toBe(true)
    expect(needsReformat('{\n  "a": 1,\n  "b": 2\n}')).toBe(false)
  })
})

describe('XML re-indenting', () => {
  it('indents element structure', () => {
    expect(reindentXml('<?xml version="1.0"?><a><b x="1"/><c><d>t</d></c></a>')).toBe(
      '<?xml version="1.0"?>\n<a>\n  <b x="1"/>\n  <c>\n    <d>t</d>\n  </c>\n</a>',
    )
  })

  it('leaves mixed content, xml:space="preserve", CDATA and comments as written', () => {
    const out = reindentXml('<doc><p>Some <b>bold</b> text</p><pre xml:space="preserve"><x>  keep  </x></pre><![CDATA[<raw>]]><!-- c --></doc>')
    expect(out).toContain('<p>Some <b>bold</b> text</p>')
    expect(out).toContain('<pre xml:space="preserve"><x>  keep  </x></pre>')
    expect(out).toContain('<![CDATA[<raw>]]>')
    expect(out).toContain('<!-- c -->')
  })

  it('returns null for mismatched tags', () => {
    expect(reindentXml('<a><b></a></b>')).toBeNull()
  })
})

describe('minified files in the code reader', () => {
  it('a minified .jsonc and .xml print indented', async () => {
    const minified = JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item ${i}` })) })
    const json = await readCode(src(minified.replace('{', '{// c\n'), 'a.jsonc'))
    expect(json.html).toMatch(/<code class="language-json">\{\n {2}\/\/ c\n {2}"items": \[/)
    const xml = await readCode(src('<root>' + '<item a="1"><v>x</v></item>'.repeat(30) + '</root>', 'web.config'))
    expect(xml.html).toContain('<code class="language-xml">&lt;root&gt;\n  &lt;item a="1"&gt;')
  })

  it('leaves a hand-formatted file alone', async () => {
    const text = '{\n    "a": 1\n}\n'
    expect((await readCode(src(text, 'a.jsonc'))).html).toContain(`<code class="language-json">{\n    "a": 1\n}\n</code>`)
  })
})

const records = (n: number): string =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `n${i + 1}`, ok: i % 2 === 0, note: null })))

describe('JSON records as a table', () => {
  it('reads an array of flat objects as a table, columns in first-seen order', async () => {
    const hub = await readJson(src('[{"id":1,"name":"a"},{"name":"b","id":2,"extra":"x"},{"id":3}]', 'r.json'))
    expect(hub.html).toMatch(/<table>.*<th>id<\/th><th>name<\/th><th>extra<\/th>/s)
    expect(hub.html).toMatch(/<td>2<\/td><td>b<\/td><td>x<\/td>/)
    expect(hub.html).toMatch(/<td>3<\/td><td><\/td><td><\/td>/)
  })

  it('shows numbers exactly as written and null as an empty cell', async () => {
    const hub = await readJson(src('[{"n":12345678901234567890,"f":1.0,"z":null,"t":true}]', 'r.json'))
    expect(hub.html).toMatch(/<td>12345678901234567890<\/td><td>1\.0<\/td><td><\/td><td>true<\/td>/)
  })

  it('allows a few nested fields, written as compact JSON', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => `{"a":${i},"b":"x","c":"y"${i === 0 ? ',"d":{"k": [1, 2]}' : ''}}`)
    const hub = await readJson(src(`[${rows.join(',')}]`, 'r.json'))
    expect(hub.html).toContain('<td>{"k":[1,2]}</td>')
  })

  it('falls back to formatted JSON when too much is nested, or it is not records at all', async () => {
    const nested = await readJson(src('[{"a":{"b":1}},{"a":{"b":2}}]', 'r.json'))
    expect(nested.html).toContain('<code class="language-json">')
    const obj = await readJson(src('{"a":1}', 'r.json'))
    expect(obj.html).toContain('<code class="language-json">')
  })

  it('prints at most 5,000 records, and says so', async () => {
    const advice: string[] = []
    const hub = await readJson(src(records(6000), 'r.json'), { onAdvice: (_k, m) => advice.push(m) })
    expect(hub.html.match(/<tr>/g)?.length).toBe(PRINT_RECORD_LIMIT + 1)
    expect(hub.html).toContain('Showing the first 5,000 of 6,000 records.')
    expect(advice.join(' ')).toMatch(/5,000 of 6,000/)
    expect(hub.limited).toBe(true)
  })

  it('exports every record', async () => {
    const sources = await readJsonRows(src(records(6000), 'r.json'))
    expect(sources).toHaveLength(1)
    expect(sources![0].header).toEqual(['id', 'name', 'ok', 'note'])
    expect((await collect(sources![0].rows)).length).toBe(6000)
  })

  it('refuses a record file over 200 MB, saying why', async () => {
    const big = { bytes: Buffer.alloc(MAX_RECORD_SOURCE_BYTES + 1, 0x20), filename: 'huge.json' }
    await expect(readJson(big)).rejects.toThrow(/over the 200 MB limit/)
    await expect(readJsonRows(big)).rejects.toThrow(/over the 200 MB limit/)
  })

  it('formats instead of tabulating when asked', async () => {
    const hub = await readJson(src(records(3), 'r.json'), { jsonAs: 'text' })
    expect(hub.html).toContain('<code class="language-json">')
    expect(await readJsonRows(src(records(3), 'r.json'), { jsonAs: 'text' })).toBeNull()
  })
})

describe('JSON Lines', () => {
  it('reads uniform records as one table', async () => {
    const hub = await readJson(src('{"a":1,"b":"x"}\n{"a":2,"b":"y"}\n\n', 'log.jsonl'))
    expect(hub.html).toMatch(/<th>a<\/th><th>b<\/th>[\s\S]*<td>2<\/td><td>y<\/td>/)
  })

  it('prints mixed lines one block each, and keeps a bad line with a notice', async () => {
    const advice: string[] = []
    const hub = await readJson(src('{"a":{"deep":1}}\n[1,2]\nnot json\n', 'log.ndjson'), { onAdvice: (_k, m) => advice.push(m) })
    expect(hub.html.match(/<pre>/g)).toHaveLength(3)
    expect(hub.html).toContain('not json')
    expect(advice.join(' ')).toMatch(/Line 3 is not JSON/)
  })
})

describe('writing row sources', () => {
  const source = (n: number, name = 'items'): RowSource => ({
    name,
    header: ['id', 'name'],
    rows: (async function* () {
      for (let i = 1; i <= n; i++) yield [String(i), `n${i}`]
    })(),
  })

  it('csv and json write every row', async () => {
    const csv = (await writeRows([source(3)], 'csv')).parts[0].bytes.toString('utf8')
    expect(csv).toBe('id,name\r\n1,n1\r\n2,n2\r\n3,n3\r\n')
    const json = JSON.parse((await writeRows([source(2)], 'json')).parts[0].bytes.toString('utf8'))
    expect(json).toEqual([{ id: 1, name: 'n1' }, { id: 2, name: 'n2' }])
  })

  it('xlsx continues a table past the sheet row limit onto "name (2)", header repeated', async () => {
    const out = await writeRows([source(25)], 'xlsx', { maxSheetRows: 10 })
    const wb = XLSX.read(out.parts[0].bytes)
    expect(wb.SheetNames).toEqual(['items', 'items (2)', 'items (3)'])
    const second = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['items (2)'], { header: 1 })
    expect(second[0]).toEqual(['id', 'name'])
    expect(second[1]).toEqual([10, 'n10'])
  })

  it('makes sheet names Excel will take', async () => {
    const out = await writeRows([source(1, 'a/b:c*d?[e]'), source(1, 'x'.repeat(40)), source(1, 'x'.repeat(40))], 'xlsx')
    const names = XLSX.read(out.parts[0].bytes).SheetNames
    expect(names[0]).toBe('a_b_c_d__e_')
    expect(names[1].length).toBeLessThanOrEqual(31)
    expect(new Set(names).size).toBe(3)
  })

  it('stops when cancelled', async () => {
    const ac = new AbortController()
    const rows = (async function* () {
      for (let i = 0; ; i++) {
        if (i === 50) ac.abort()
        yield [String(i), 'x']
      }
    })()
    await expect(writeRows([{ name: 't', header: ['a', 'b'], rows }], 'csv', { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('detection and the command line', () => {
  it('routes .json, .jsonl and .ndjson to the JSON reader, and .jsonc/.json5 to code', () => {
    for (const f of ['a.json', 'a.jsonl', 'a.ndjson']) expect(detect(Buffer.from('[]'), f)).toEqual({ kind: 'ok', format: 'json' })
    for (const f of ['a.jsonc', 'a.json5', 'a.xsd', 'a.xsl', 'a.csproj', 'web.config', 'a.plist'])
      expect(detect(Buffer.from('x'), f)).toEqual({ kind: 'ok', format: 'code' })
  })

  it('--json-as takes table or text, and only for JSON input', () => {
    const r = parseArgs(['a.json', '--to', 'csv', '--json-as', 'text'])
    expect(r.kind === 'ok' && r.req.jsonAs).toBe('text')
    expect(parseArgs(['a.json', '--to', 'csv', '--json-as', 'grid']).kind).toBe('usage')
    expect(checkFlagScope(['--json-as'], 'csv', ['md'])).toMatch(/--json-as/)
    expect(checkFlagScope(['--json-as'], 'csv', ['json'])).toBeNull()
  })
})
