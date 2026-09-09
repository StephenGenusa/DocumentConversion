import { describe, it, expect } from 'vitest'
import { readIpynb } from '../../src/core/readers/ipynb'
import { detect } from '../../src/core/detect'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const notebook = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { language_info: { name: 'python' }, kernelspec: { language: 'python', name: 'python3' } },
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Analysis Notes\n', '\n', 'The **credit window** grows.'] },
    {
      cell_type: 'code',
      metadata: {},
      execution_count: 1,
      source: ['grant = 64\n', 'print(grant + 16)'],
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['80\n'] }],
    },
    {
      cell_type: 'code',
      metadata: {},
      execution_count: 2,
      source: 'plot(window)',
      outputs: [
        { output_type: 'display_data', data: { 'image/png': PNG_B64 }, metadata: {} },
        { output_type: 'execute_result', data: { 'text/plain': ['<Figure 640x480>'] }, metadata: {} },
      ],
    },
    {
      cell_type: 'code',
      metadata: {},
      source: ['1/0'],
      outputs: [
        {
          output_type: 'error',
          ename: 'ZeroDivisionError',
          evalue: 'division by zero',
          traceback: ['[31mZeroDivisionError[0m: division by zero'],
        },
      ],
    },
  ],
}

const src = (nb: unknown, filename = 'analysis.ipynb') => ({
  bytes: Buffer.from(JSON.stringify(nb), 'utf8'),
  filename,
})

describe('readIpynb', () => {
  it('renders markdown cells through the markdown pipeline', async () => {
    const hub = await readIpynb(src(notebook))
    expect(hub.html).toContain('<h1>Analysis Notes</h1>')
    expect(hub.html).toContain('<strong>credit window</strong>')
  })

  it('renders code cells as language-tagged fences', async () => {
    const hub = await readIpynb(src(notebook))
    expect(hub.html).toMatch(/<pre class="nb-in[^"]*"><code class="language-python">/)
    expect(hub.html).toContain('print(grant + 16)')
  })

  it('renders stream and text outputs, embeds png outputs', async () => {
    const hub = await readIpynb(src(notebook))
    expect(hub.html).toContain('80')
    expect(hub.html).toContain('&lt;Figure 640x480&gt;')
    expect(hub.html).toContain(`data:image/png;base64,${PNG_B64.slice(0, 20)}`)
  })

  it('renders error tracebacks with ANSI codes stripped', async () => {
    const hub = await readIpynb(src(notebook))
    expect(hub.html).toContain('ZeroDivisionError')
    expect(hub.html).not.toContain('[31m')
  })

  /**
   * A pandas DataFrame is stored as a rich text/html table AND an ASCII
   * text/plain fallback. Rendering the fallback dropped the only real table in
   * the corpus notebooks, so ipynb -> csv/json/xlsx reported "no-tables" on a
   * document that demonstrably has one.
   */
  it('prefers a text/html table output over its text/plain fallback', async () => {
    const nb = {
      ...notebook,
      cells: [
        {
          cell_type: 'code',
          source: 'results.head()',
          outputs: [
            {
              output_type: 'execute_result',
              data: {
                'text/html': [
                  '<div>\n<style scoped>.dataframe th { text-align: right; }</style>\n',
                  '<table border="1" class="dataframe">',
                  '<thead><tr><th>parameters</th><th>aic</th></tr></thead>',
                  '<tbody><tr><td>(2, 3, 1, 1)</td><td>3888.642174</td></tr></tbody>',
                  '</table>\n</div>',
                ],
                'text/plain': ['     parameters          aic\n0  (2, 3, 1, 1)  3888.642174'],
              },
            },
          ],
        },
      ],
    }
    const hub = await readIpynb(src(nb))
    expect(hub.html).toContain('<table')
    expect(hub.html).toContain('<th>parameters</th>')
    expect(hub.html).toContain('<td>3888.642174</td>')
    // The fallback must not also appear: both would duplicate every value.
    expect(hub.html).not.toContain('nb-output')
    expect(hub.html).not.toContain('3888.642174</pre>')
    // Notebook HTML is still untrusted input — it goes through the hub allowlist.
    expect(hub.html).not.toContain('<style')
    expect(hub.html).not.toContain('text-align: right')
  })

  it('falls back to text/plain when the html output carries no content', async () => {
    const nb = {
      ...notebook,
      cells: [
        {
          cell_type: 'code',
          source: 'x',
          outputs: [
            {
              output_type: 'execute_result',
              data: { 'text/html': ['<style>.a{color:red}</style>'], 'text/plain': ['42'] },
            },
          ],
        },
      ],
    }
    const hub = await readIpynb(src(nb))
    expect(hub.html).toContain('42')
  })

  it('keeps a png output alongside an html output', async () => {
    const nb = {
      ...notebook,
      cells: [
        {
          cell_type: 'code',
          source: 'fig',
          outputs: [
            {
              output_type: 'display_data',
              data: { 'image/png': PNG_B64, 'text/html': ['<p>caption</p>'] },
            },
          ],
        },
      ],
    }
    const hub = await readIpynb(src(nb))
    expect(hub.html).toContain(`data:image/png;base64,${PNG_B64.slice(0, 20)}`)
    expect(hub.html).toContain('caption')
  })

  /**
   * A code cell and its output shipped as two IDENTICAL grey <pre> boxes, with
   * nothing saying where input ended and output began and no execution
   * prompts. The hub allowlist permits `class` on `pre`/`code` and nothing
   * else, so the distinction has to ride on those classes.
   */
  describe('cell roles and execution prompts', () => {
    it('marks a code input pre with nb-in and its execution count', async () => {
      const hub = await readIpynb(src(notebook))
      expect(hub.html).toContain('<pre class="nb-in nb-c1"><code class="language-python">')
      expect(hub.html).toContain('<pre class="nb-in nb-c2"><code class="language-python">')
    })

    it('omits the count class for an unexecuted cell rather than inventing one', async () => {
      const hub = await readIpynb(src(notebook))
      // The 1/0 cell has no execution_count at all.
      expect(hub.html).toContain('<pre class="nb-in"><code class="language-python">1/0</code></pre>')
      expect(hub.html).not.toContain('nb-cnull')
      expect(hub.html).not.toContain('nb-cundefined')
    })

    it('marks stream output apart from execute_result output', async () => {
      const hub = await readIpynb(src(notebook))
      expect(hub.html).toContain('<pre class="nb-output nb-stream">80</pre>')
      expect(hub.html).toContain('<pre class="nb-output nb-result nb-c2">&lt;Figure 640x480&gt;</pre>')
    })

    /** Jupyter prompts an execute_result with its CELL's number when the
     * output does not repeat one; it prompts display_data with nothing. */
    it('falls back to the cell count for a result, and never prompts display_data', async () => {
      const nb = {
        ...notebook,
        cells: [
          {
            cell_type: 'code',
            execution_count: 9,
            source: 'fig, df',
            outputs: [
              { output_type: 'display_data', data: { 'text/plain': ['<Figure>'] } },
              { output_type: 'execute_result', data: { 'text/plain': ['ok'] } },
            ],
          },
        ],
      }
      const hub = await readIpynb(src(nb))
      expect(hub.html).toContain('<pre class="nb-output nb-display">&lt;Figure&gt;</pre>')
      expect(hub.html).toContain('<pre class="nb-output nb-result nb-c9">ok</pre>')
    })

    it('carries the result execution count so it can be prompted Out[n]', async () => {
      const nb = {
        ...notebook,
        cells: [
          {
            cell_type: 'code',
            execution_count: 7,
            source: '2 + 2',
            outputs: [{ output_type: 'execute_result', execution_count: 7, data: { 'text/plain': ['4'] } }],
          },
        ],
      }
      const hub = await readIpynb(src(nb))
      expect(hub.html).toContain('<pre class="nb-in nb-c7">')
      expect(hub.html).toContain('<pre class="nb-output nb-result nb-c7">4</pre>')
    })

    it('marks a stderr stream so warnings do not read as results', async () => {
      const nb = {
        ...notebook,
        cells: [
          {
            cell_type: 'code',
            execution_count: 3,
            source: 'warn()',
            outputs: [{ output_type: 'stream', name: 'stderr', text: ['DeprecationWarning: old\n'] }],
          },
        ],
      }
      const hub = await readIpynb(src(nb))
      expect(hub.html).toContain('<pre class="nb-output nb-stream nb-stderr">DeprecationWarning: old</pre>')
    })

    it('keeps the error class on a traceback', async () => {
      const hub = await readIpynb(src(notebook))
      expect(hub.html).toMatch(/<pre class="nb-error">ZeroDivisionError/)
    })

    it('leaves a raw cell unclassed', async () => {
      const nb = { ...notebook, cells: [{ cell_type: 'raw', source: 'verbatim text' }] }
      const hub = await readIpynb(src(nb))
      expect(hub.html).toBe('<pre>verbatim text</pre>')
    })
  })

  it('uses the filename as title and rejects non-notebook JSON', async () => {
    const hub = await readIpynb(src(notebook))
    expect(hub.title).toBe('analysis.ipynb')
    await expect(readIpynb(src({ not: 'a notebook' }))).rejects.toMatchObject({ code: 'read-failed' })
  })
})

describe('ipynb detection', () => {
  it('maps the extension', () => {
    expect(detect(Buffer.from('{}'), 'a.ipynb')).toEqual({ kind: 'ok', format: 'ipynb' })
  })
  it('sniffs extensionless notebook JSON', () => {
    expect(detect(Buffer.from(JSON.stringify(notebook)))).toEqual({ kind: 'ok', format: 'ipynb' })
  })
  it('does not claim ordinary JSON', () => {
    const r = detect(Buffer.from('{"a": 1}'), 'x.dat')
    expect(r).toEqual({ kind: 'ok', format: 'txt' })
  })
})

/**
 * A display_data bundle carries one value at several richnesses, exactly like
 * execute_result: matplotlib ships the figure as image/png AND a
 * "<Figure size 1080x1080 with 2 Axes>" string as text/plain. The string is the
 * FALLBACK for the image, and Jupyter shows only one of them — rendering both
 * put a placeholder caption next to every figure in the corpus notebooks.
 */
/**
 * Notebook markdown cells reference images by relative path
 * (`<img src="../../img/ods_stickers.jpg">`) and code outputs carry their own
 * images inline as data URIs. Only the second kind can resolve once the
 * document leaves its source directory; the first painted a broken-image icon
 * on the first page of six corpus notebooks.
 */
describe('readIpynb unresolvable images', () => {
  const withMarkdown = (source: string) => ({ ...notebook, cells: [{ cell_type: 'markdown', source }] })

  it('drops a relative image in a markdown cell', async () => {
    const hub = await readIpynb(src(withMarkdown('<img src="../../img/ods_stickers.jpg" />\n')))
    expect(hub.html).not.toContain('<img')
    expect(hub.html).not.toContain('ods_stickers')
  })

  it('keeps a remote image in a markdown cell', async () => {
    const hub = await readIpynb(
      src(withMarkdown("<img src='https://habrastorage.org/web/4a9/edb/082/x.jpg' align='right' width=40%>\n")),
    )
    expect(hub.html).toContain('src="https://habrastorage.org/web/4a9/edb/082/x.jpg"')
  })

  it('still inlines its own png outputs as data URIs', async () => {
    const hub = await readIpynb(src(notebook))
    expect(hub.html).toContain(`data:image/png;base64,${PNG_B64.slice(0, 20)}`)
  })

  it('strips a relative image inside a text/html output', async () => {
    const nb = {
      ...notebook,
      cells: [
        {
          cell_type: 'code',
          source: 'render()',
          outputs: [
            {
              output_type: 'execute_result',
              data: { 'text/html': ['<p>chart <img src="charts/a.png" alt="chart"></p>'] },
            },
          ],
        },
      ],
    }
    const hub = await readIpynb(src(nb))
    expect(hub.html).not.toContain('charts/a.png')
    expect(hub.html).toContain('[chart]')
  })
})

/**
 * A figure output cannot carry a class: the hub allowlist permits `class` on
 * `pre` and `code` and nothing else. The shell selects it by the alt text the
 * reader stamps on every figure it inlines, so that string is a contract
 * between the two — see the matching rule in tests/core/shell.test.ts.
 */
describe('readIpynb figure marker', () => {
  it('stamps every inlined figure with the alt the shell styles on', async () => {
    const hub = await readIpynb(src(notebook))
    expect(hub.html).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="output image">/)
  })
})

describe('readIpynb figure fallbacks', () => {
  const figure = (data: Record<string, unknown>) => ({
    ...notebook,
    cells: [{ cell_type: 'code', execution_count: 4, source: 'plt.show()', outputs: [{ output_type: 'display_data', data }] }],
  })

  it('drops the text/plain fallback when the image is rendered', async () => {
    const hub = await readIpynb(
      src(figure({ 'image/png': PNG_B64, 'text/plain': ['<Figure size 1080x1080 with 2 Axes>'] })),
    )
    expect(hub.html).toContain(`data:image/png;base64,${PNG_B64.slice(0, 20)}`)
    expect(hub.html).not.toContain('Figure size')
  })

  it('still shows text/plain when there is no image to fall back from', async () => {
    const hub = await readIpynb(src(figure({ 'text/plain': ['array([1, 2, 3])'] })))
    expect(hub.html).toContain('array([1, 2, 3])')
  })
})

/**
 * Everything a notebook supplies is untrusted. Three of its values land inside
 * HTML ATTRIBUTES — the kernel language, the base64 of a figure — and an
 * escaper that leaves `"` alone lets any of them close the attribute early.
 */
describe('readIpynb attribute safety', () => {
  it('escapes a quote in the kernel language name', async () => {
    const nb = {
      ...notebook,
      metadata: { language_info: { name: 'python" onmouseover="alert(1)' } },
      cells: [{ cell_type: 'code', execution_count: 1, source: 'x = 1', outputs: [] }],
    }
    const hub = await readIpynb(src(nb))
    expect(hub.html).not.toContain('onmouseover="')
    expect(hub.html).toMatch(/<code class="[^"]*">/)
  })

  it('escapes a quote smuggled into an image/png payload', async () => {
    const nb = {
      ...notebook,
      cells: [
        {
          cell_type: 'code',
          execution_count: 1,
          source: 'plt.show()',
          outputs: [{ output_type: 'display_data', data: { 'image/png': 'AAAA" onerror="alert(1)' } }],
        },
      ],
    }
    const hub = await readIpynb(src(nb))
    expect(hub.html).not.toContain('onerror="')
    expect(hub.html).toMatch(/<img src="[^"]*" alt="output image">/)
  })
})

/**
 * Diff-review follow-up. Only `image/png` was rendered; a JPEG or SVG figure
 * (PIL, plotly, seaborn's svg backend) fell through to its text/plain
 * fallback and printed as `<Figure size 640x480 with 1 Axes>`. And when a png
 * WAS present every text/plain beside it was dropped — right for that
 * matplotlib caption, wrong for a real repr.
 */
describe('notebook figure formats', () => {
  const cellWith = (data: Record<string, unknown>, plain?: string): unknown => ({
    ...notebook,
    cells: [
      {
        cell_type: 'code',
        source: 'fig',
        outputs: [{ output_type: 'display_data', data: { ...data, ...(plain ? { 'text/plain': [plain] } : {}) } }],
      },
    ],
  })
  const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='

  it('renders a jpeg output as a figure', async () => {
    const hub = await readIpynb(src(cellWith({ 'image/jpeg': JPEG_B64 }, '<Figure size 640x480 with 1 Axes>')))
    expect(hub.html).toContain('data:image/jpeg;base64,/9j/')
    expect(hub.html).not.toContain('Figure size')
  })

  it('renders an svg output as a figure', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
    const hub = await readIpynb(src(cellWith({ 'image/svg+xml': [svg] }, '<Figure size 640x480 with 1 Axes>')))
    expect(hub.html).toContain('data:image/svg+xml;base64,')
    expect(hub.html).not.toContain('Figure size')
    expect(hub.html).not.toContain('<svg')
  })

  it('still drops the matplotlib caption beside a png', async () => {
    const hub = await readIpynb(src(cellWith({ 'image/png': PNG_B64 }, '<Figure size 640x480 with 1 Axes>')))
    expect(hub.html).not.toContain('Figure size')
  })

  it('keeps a real text repr that accompanies a png', async () => {
    const hub = await readIpynb(src(cellWith({ 'image/png': PNG_B64 }, 'array([1, 2, 3])')))
    expect(hub.html).toContain('array([1, 2, 3])')
  })
})
