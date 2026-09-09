#!/usr/bin/env node
/**
 * Builds tests/corpus/branch-directory.html from the shared vocabulary.
 *
 * It used to be a hand-edited file, which meant its text was outside the one
 * place corpus wording is supposed to come from. Generating it keeps the whole
 * corpus answerable to a single reviewed list.
 *
 *   node scripts/fixtures/build-directory-html.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as V from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus/branch-directory.html')
const D = V.DIRECTORY_HTML

const C = D.chrome

/** Rows pair a branch with its region; the last has no plan image on purpose. */
const rows = V.BRANCHES.map((site, i) => {
  const plan =
    i < V.BRANCHES.length - 1
      ? `<img src="/_layouts/images/plan${i}.png" alt="${site} reading room plan">`
      : ''
  return `<tr><td>${site}</td><td>${V.REGIONS[i]}</td><td>${plan}</td></tr>`
}).join('\n')

/** Visible label plus its screen-reader-only sibling, the way SharePoint emits it. */
const tab = ([label, sr]) =>
  `<td><a href="javascript:;">${label}<span class="ms-cui-hidden">${sr}</span></a></td>`

writeFileSync(
  OUT,
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${D.title}</title></head>
<body>
<table role="presentation" width="100%"><tr>
  <td><a href="javascript:;">${C.siteTitle}<span class="ms-hidden">${C.selected}</span></a></td>
  ${C.tabs.map(tab).join('\n  ')}
  ${C.links.map((l) => `<td><a href="/site/${l.toLowerCase()}">${l}</a></td>`).join('\n  ')}
</tr></table>
<table role="presentation"><tr><td>
  <img alt="${C.navigateUp}">
</td></tr></table>
<h1>${D.heading}</h1>
<p>${D.lead}</p>
<table>
<thead><tr>${D.columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p>${D.note}</p>
<p>${C.icons.map((n) => `<img src="/_layouts/images/spcommon.png" alt="${n}">`).join(' ')}</p>
<p>${D.footer}</p>
</body>
</html>
`,
)
console.log('wrote', OUT)
