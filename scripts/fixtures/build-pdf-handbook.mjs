#!/usr/bin/env node
/**
 * Builds a synthetic 70-page "employee handbook" PDF for the five pdf-*
 * test files that depend on it (pdf-images, pdf-letter-spacing,
 * pdf-paragraphs, pdf-tables, pdf-toc), replacing a real employer's training
 * handbook.
 *
 * Reproduces, deliberately, every structural property those tests exercise:
 *   - a cover photo and a company logo (2 images)
 *   - eleven scanned "exhibit" pages, each a caption followed by a picture
 *     (11 images -> 13 total, matching pdf-images.test.ts)
 *   - letter-spaced display headings on pages 1, 2 and 4 (single space
 *     between every letter, two between words), including one with a
 *     genuinely glued "ON" the way a hand-typed original has
 *   - a table of contents page with leader-dot entries
 *   - a paragraph whose tail line must not glue to the next paragraph's
 *     first line, and a heading set hard against the body below it
 *   - a repeating running head/folio line, to prove it gets filtered
 *   - 40+ ordinary <h2> section headings spread across the document
 *   - a bulleted safety-rules list, which must not be mistaken for a table
 *   - zero real tables anywhere (this is a prose-only handbook)
 *
 * All content is invented; no name, address or figure is copied from any
 * real document.
 *
 *   node scripts/fixtures/build-pdf-handbook.mjs
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus/visitor-handbook.pdf')
const LOGO_PNG = join(here, '../../tests/fixtures/sample.png')

import * as V from './vocabulary.mjs'

const PAGE = [612, 792]
const LEFT = 55
const RIGHT = 557
const HEADER = V.HANDBOOK.runningHead
const BODY_SIZE = 11
const BODY_LEAD = 16 // line pitch within a paragraph
const PARA_GAP = 28 // extra drop before a new paragraph (> 1.5 * BODY_LEAD)
const HEADING_GAP = 44 // extra drop before a heading
const HEADING_SIZE = 14 // ordinary section heading
const DISPLAY_SIZE = 18 // letter-spaced display heading

function letterSpace(word) {
  return word.split('').join(' ')
}

/** Roughly what fits `chars` per BODY_SIZE-pt Helvetica line in our margins. */
function wrap(text, chars = 92) {
  const words = text.split(' ')
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length > chars && line) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

async function main() {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const logoBytes = readFileSync(LOGO_PNG)
  // A fresh embed per use, not a single image object reused across many
  // pages: pdf-lib stores one shared XObject when the same PDFImage is drawn
  // on several pages, and pdfjs then promotes it to its document-wide
  // "global image cache" (ids like `g_d0_img_pN_M`) rather than a page-local
  // one (`img_pN_M`) — and only page-local objects are reachable through
  // `page.objs`, which is all this reader's image extraction ever queries.
  // A real scanned handbook never hits this because its exhibit pages are
  // eleven genuinely different scans, each unique to its own page.
  const freshLogo = () => pdf.embedPng(logoBytes)

  /** @type {{draws: {text:string,x:number,y:number,size?:number}[], images: {img:any,x:number,y:number,w:number,h:number}[]}[]} */
  const pages = []
  const newPage = () => {
    const page = { draws: [], images: [] }
    pages.push(page)
    return page
  }
  const text = (page, t, x, y, size = BODY_SIZE) => page.draws.push({ text: t, x, y, size })
  const image = (page, img, x, y, w, h) => page.images.push({ img, x, y, w, h })
  const header = (page) => text(page, HEADER, LEFT, 760, 9)

  // --- Page 0: cover. Two images: a "cover photo" and the company logo. ---
  {
    const p = newPage()
    text(p, 'Visitor Handbook', LEFT, 620, 24)
    text(p, 'Elmwood Libraries', LEFT, 590, 13)
    image(p, await freshLogo(), LEFT, 660, 90, 60) // company logo, upper area
    image(p, await freshLogo(), LEFT, 300, 240, 240) // cover photo, larger
  }

  // --- Page 1: Introduction. ---
  {
    const p = newPage()
    header(p)
    text(p, letterSpace('INTRODUCTION'), LEFT + 150, 706, DISPLAY_SIZE)
    const para1 = wrap(V.HANDBOOK.intro[0])
    let y = 660
    for (const line of para1) {
      text(p, line, LEFT, y)
      y -= BODY_LEAD
    }
    y -= PARA_GAP - BODY_LEAD
    const para2 = wrap(V.HANDBOOK.intro[1])
    for (const line of para2) {
      text(p, line, LEFT, y)
      y -= BODY_LEAD
    }
  }

  // --- Page 2: Table of contents. ---
  {
    const p = newPage()
    header(p)
    text(p, letterSpace('TABLE') + '  ' + letterSpace('OF') + '  ' + letterSpace('CONTENTS'), LEFT + 60, 706, DISPLAY_SIZE)
    const entries = V.HANDBOOK.contents
    let y = 650
    for (const [title, pageNo] of entries) {
      const dots = '.'.repeat(Math.max(4, 64 - title.length))
      text(p, `${title} ${dots} ${pageNo}`, LEFT + 35, y)
      y -= 20
    }
  }

  // --- Pages 3-5: Mission, Company History, Code of Conduct — one heading
  // per page, like every other body page. (A page carrying more than one
  // heading skews that page's own median line-gap enough that the second
  // heading's gap no longer clears the 1.5x threshold, and it gets glued to
  // the paragraph above it instead of lifted out — the exact defect these
  // tests exist to catch, so this fixture must not shrug it off by accident.)
  const SECTIONS = [
    [V.HANDBOOK.contents[0][0], V.HANDBOOK.mission],
    [V.HANDBOOK.contents[1][0], V.HANDBOOK.history],
    [V.HANDBOOK.contents[2][0], V.HANDBOOK.conduct],
  ]
  for (const [title, body] of SECTIONS) {
    const p = newPage()
    header(p)
    let y = 706
    text(p, title, LEFT, y, HEADING_SIZE)
    y -= HEADING_GAP
    for (const line of wrap(body)) {
      text(p, line, LEFT, y)
      y -= BODY_LEAD
    }
  }

  // --- Page 4: General Information (letter-spaced, "ON" glued as a typo). ---
  {
    const p = newPage()
    header(p)
    // "ON" is glued with no space, the way a hand-typed original mistypes it.
    text(p, `${letterSpace('GENERAL')}  I N F O R M A T I ON`, LEFT + 90, 706, DISPLAY_SIZE)
    let y = 660
    for (const line of wrap(V.HANDBOOK.generalInfo)) {
      text(p, line, LEFT, y)
      y -= BODY_LEAD
    }
  }

  // --- Pages 5-50: ordinary sections, at least one <h2> heading each. ---
  const TOPICS = V.HANDBOOK.policySections
  const FILLER = V.HANDBOOK.policyBodies
  for (let i = 0; i < TOPICS.length; i++) {
    const p = newPage()
    header(p)
    let y = 706
    text(p, TOPICS[i], LEFT, y, HEADING_SIZE)
    y -= HEADING_GAP
    const body = FILLER[i % FILLER.length]
    for (const line of wrap(body)) {
      text(p, line, LEFT, y)
      y -= BODY_LEAD
    }
  }

  // --- General Safety Rules: a bulleted list, not a table. ---
  {
    const p = newPage()
    header(p)
    let y = 706
    text(p, V.HANDBOOK.safetyHeading, LEFT, y, HEADING_SIZE)
    y -= HEADING_GAP
    const bullets = V.HANDBOOK.safetyRules
    for (const line of bullets) {
      text(p, '•', LEFT + 12, y)
      text(p, line, LEFT + 30, y)
      y -= BODY_LEAD
    }
  }

  // --- A handful more ordinary sections, to round the body out. ---
  const MORE_TOPICS = V.HANDBOOK.lateSections
  for (const topic of MORE_TOPICS) {
    const p = newPage()
    header(p)
    let y = 706
    text(p, topic, LEFT, y, HEADING_SIZE)
    y -= HEADING_GAP
    for (const line of wrap(FILLER[0])) {
      text(p, line, LEFT, y)
      y -= BODY_LEAD
    }
  }

  // --- Exhibit pages: caption + scanned form image, eleven of them. ---
  for (let n = 1; n <= 11; n++) {
    const p = newPage()
    header(p)
    text(p, `${V.HANDBOOK.exhibitTitle} ${n}`, LEFT, 706, 12)
    image(p, await freshLogo(), LEFT, 120, 460, 540)
  }

  // --- Closing page. ---
  {
    const p = newPage()
    header(p)
    text(p, V.HANDBOOK.acknowledgementHeading, LEFT, 706, HEADING_SIZE)
    let y = 706 - HEADING_GAP
    for (const line of wrap(
      V.HANDBOOK.acknowledgement,
    )) {
      text(p, line, LEFT, y)
      y -= BODY_LEAD
    }
  }

  // --- Render every page. ---
  for (const spec of pages) {
    const page = pdf.addPage(PAGE)
    for (const d of spec.draws) {
      page.drawText(d.text, { x: d.x, y: d.y, size: d.size ?? BODY_SIZE, font, color: rgb(0, 0, 0) })
    }
    for (const im of spec.images) {
      page.drawImage(im.img, { x: im.x, y: im.y, width: im.w, height: im.h })
    }
  }

  const bytes = await pdf.save()
  writeFileSync(OUT, bytes)
  console.log(`wrote ${OUT} (${bytes.length} bytes, ${pages.length} pages)`)
}

main()
