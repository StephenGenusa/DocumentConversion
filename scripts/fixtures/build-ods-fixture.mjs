#!/usr/bin/env node
/**
 * Builds tests/corpus/stock-formatting.ods: an OpenDocument spreadsheet whose
 * cells carry bold, italic, underline, strikethrough, superscript and
 * subscript the ways LibreOffice writes them — a cell style on the cell, a
 * column's default cell style, a named style inherited through a parent, and
 * text spans inside a cell's paragraph. Around them are the structures the
 * formatting has to stay aligned through: a merged cell, repeated empty rows
 * and columns, and a cell of two paragraphs. A second sheet holds notes.
 *
 * Written as XML here rather than by SheetJS, which writes no styles.
 *
 *   node scripts/fixtures/build-ods-fixture.mjs
 */
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import * as V from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus/stock-formatting.ods')
const S = V.STOCK_ODS

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3"'

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS}><office:styles>
<style:style style:name="Default" style:family="table-cell"><style:text-properties fo:font-weight="normal"/></style:style>
<style:style style:name="Heading" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>
</office:styles></office:document-styles>`

const AUTO = `<office:automatic-styles>
<style:style style:name="ceHead" style:family="table-cell" style:parent-style-name="Heading"/>
<style:style style:name="ceBold" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="ceItalic" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="ceStruck" style:family="table-cell" style:parent-style-name="Default"><style:text-properties style:text-line-through-style="solid"/></style:style>
<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="T3" style:family="text"><style:text-properties style:text-underline-style="solid"/></style:style>
<style:style style:name="T4" style:family="text"><style:text-properties style:text-position="super 58%"/></style:style>
<style:style style:name="T5" style:family="text"><style:text-properties style:text-position="sub 58%"/></style:style>
</office:automatic-styles>`

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`

const span = (style, text) => `<text:span text:style-name="${style}">${text}</text:span>`
const text = (inner, attrs = '') => `<table:table-cell office:value-type="string"${attrs}><text:p>${inner}</text:p></table:table-cell>`
const num = (n, attrs = '') => `<table:table-cell office:value-type="float" office:value="${n}"${attrs}><text:p>${n}</text:p></table:table-cell>`
const row = (...cells) => `<table:table-row>${cells.join('')}</table:table-row>`
const bold = ' table:style-name="ceBold"'

const [m, it, g, sz] = [V.MATERIALS, V.ITEMS, V.GROUPS, V.SIZES]
const stock =
  // Group (column C) is italic by its column's default cell style.
  '<table:table-column table:default-cell-style-name="Default" table:number-columns-repeated="2"/>' +
  '<table:table-column table:default-cell-style-name="ceItalic"/>' +
  '<table:table-column table:default-cell-style-name="Default" table:number-columns-repeated="1021"/>' +
  row(...S.headers.map((h) => text(h, ' table:style-name="ceHead"'))) +
  row(text('C-1001'), text(`${span('T1', m[0])} ${it[0]} ${sz[0]}`), text(g[0]), num(4)) +
  row(text('C-1002', bold), text(`${m[1]} ${it[2]} ${sz[1]}`, bold), text(g[1], bold), num(12, bold)) +
  row(text('C-1003'), text(`${m[2]} ${it[4]} ${span('T2', V.SPECS[0])}`, ' table:style-name="ceStruck"'), text(g[2]), num(1)) +
  row(text('C-1004'), text(`${m[3]} ${it[6]} ${V.SPECS[3].replace(/\d$/, (d) => span('T4', d))}`), text(span('T3', g[3])), num(7)) +
  row(text('C-1005'), text(`${m[4]} ${it[8]} A${span('T5', '5')}`), text(g[4]), num(3)) +
  '<table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="4"/></table:table-row>' +
  row(
    `<table:table-cell office:value-type="string" table:number-columns-spanned="2" table:style-name="ceBold"><text:p>${S.wide}</text:p></table:table-cell>`,
    '<table:covered-table-cell/>',
    text(g[5]),
    `<table:table-cell office:value-type="string"><text:p>${span('T1', S.twoLines[0])}</text:p><text:p>${S.twoLines[1]}</text:p></table:table-cell>`,
  ) +
  '<table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>'

const notes =
  row(text(`${span('T1', 'Bold')} rows are reordered first.`)) +
  row(text('Struck items are withdrawn from the catalogue.', ' table:style-name="ceStruck"')) +
  row(text(`${span('T3', 'Underlined')} groups are shared between branches.`))

const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS}>${AUTO}<office:body><office:spreadsheet>
<table:table table:name="${S.sheet}">${stock}</table:table>
<table:table table:name="${S.notesSheet}">${notes}</table:table>
</office:spreadsheet></office:body></office:document-content>`

const zip = new JSZip()
// A fixed date, so the file is the same byte for byte on every run.
const date = new Date('2026-01-01T00:00:00Z')
zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE', date })
zip.file('META-INF/manifest.xml', MANIFEST, { date })
zip.file('content.xml', content, { date })
zip.file('styles.xml', STYLES, { date })
await writeFile(OUT, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
console.log('stock-formatting.ods written')
