// Shared helpers for hand-building minimal but structurally valid .docx
// packages with JSZip — no PII, fully synthetic content. Used by the
// tests/corpus/ fixture generators.
import JSZip from 'jszip'

export const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
export const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
export const WP = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
export const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
export const PIC = 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

/** A trivial, valid 3x1 PNG — the same bytes used by tests/fixtures/gen-fixtures.mjs. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAYAAACczIWkAAAAEklEQVR4nGNgYGD4z8DA8B8ABQ0CAmXEU2sAAAAASUVORK5CYII=',
  'base64',
)

/** One `<w:p>` of plain text, optionally with an inline tab between two runs. */
export function para(text) {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

/** A paragraph made of explicit runs — text and `tab` markers mixed. */
export function paraRuns(parts) {
  const runs = parts
    .map((p) => (p === '\t' ? '<w:r><w:tab/></w:r>' : `<w:r><w:t xml:space="preserve">${p}</w:t></w:r>`))
    .join('')
  return `<w:p>${runs}</w:p>`
}

/** One numbered/bulleted paragraph belonging to `numId`. */
export function listItem(numId, text, ilvl = 0) {
  return (
    `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr>` +
    `<w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>` +
    `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
  )
}

/** One inline `<w:drawing>` run referencing relationship `rId`. Returned bare, for embedding in a `<w:p>`. */
function drawingRun(rId, id) {
  const cx = 914400 // 1 inch, in EMU
  const cy = 274320 // 0.3 inch
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  )
}

/** A `<w:p>` holding `count` inline images, each a fresh relationship id from `rIds`. */
export function imageParagraph(rIds, idStart) {
  const runs = rIds.map((rId, i) => drawingRun(rId, idStart + i)).join('')
  return `<w:p>${runs}</w:p>`
}

/**
 * Deterministic image relationship ids, so the body-building code and
 * `buildDocx`'s own rels/media wiring agree on names without a two-way
 * handshake: both just call this with the same count.
 */
export function imageRelIds(count) {
  return Array.from({ length: count }, (_, i) => `rImg${i + 1}`)
}

/**
 * Builds a minimal but valid .docx: document.xml body, optional header/footer
 * parts, optional numbering.xml, and an arbitrary number of embedded PNGs
 * referenced by w:drawing relationships. Mirrors the structure
 * tests/core/reader-docx.test.ts and reader-docx-fidelity.test.ts already hand
 * -build for the same reader, so mammoth reads it the same way it reads a real
 * Word file.
 */
export async function buildDocx({ body, headers = {}, footers = {}, numberingXml, imageCount = 0 }) {
  const zip = new JSZip()
  const rels = []
  const refs = { header: [], footer: [] }
  const parts = []
  let n = 0

  const addHeaderFooter = (kind, type, xml) => {
    n += 1
    const file = `${kind}${n}.xml`
    rels.push(
      `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${file}"/>`,
    )
    refs[kind].push(`<w:${kind}Reference w:type="${type}" r:id="rId${n}"/>`)
    const wrapped = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${kind === 'header' ? 'hdr' : 'ftr'} ${W} ${R}>${xml}</w:${kind === 'header' ? 'hdr' : 'ftr'}>`
    parts.push([`word/${file}`, wrapped])
  }
  for (const [type, xml] of Object.entries(headers)) addHeaderFooter('header', type, xml)
  for (const [type, xml] of Object.entries(footers)) addHeaderFooter('footer', type, xml)

  const mediaFiles = []
  for (const rId of imageRelIds(imageCount)) {
    const file = `${rId}.png`
    rels.push(
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${file}"/>`,
    )
    mediaFiles.push([`word/media/${file}`, TINY_PNG])
  }

  let numberingRelXml = ''
  if (numberingXml) {
    n += 1
    numberingRelXml = `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`
  }

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      (numberingXml
        ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
        : '') +
      `</Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W} ${R} ${WP} ${A} ${PIC}><w:body>${body}<w:sectPr>${refs.header.join('')}${refs.footer.join('')}</w:sectPr></w:body></w:document>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}${numberingRelXml}</Relationships>`,
  )
  if (numberingXml) zip.file('word/numbering.xml', numberingXml)
  for (const [name, xml] of parts) zip.file(name, xml)
  for (const [name, bytes] of mediaFiles) zip.file(name, bytes)

  return zip.generateAsync({ type: 'nodebuffer' })
}

/** A single-list numbering.xml: one decimal list, numId 1. */
export function decimalNumberingXml() {
  return (
    `<?xml version="1.0"?><w:numbering ${W}>` +
    `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
  )
}
