#!/usr/bin/env node
/**
 * Builds three synthetic `.msg` fixtures for `tests/core/reader-msg.test.ts`,
 * replacing real corpus files that carried named colleagues, a real employer
 * domain and internal reference numbers.
 *
 * Each reproduces the one structural property those tests exercise: Exchange
 * stores an internal party's address as an X.500 distinguished name rather
 * than an SMTP address, and the real address has to be read from a sibling
 * property (`PidTagSenderSmtpAddress` / `PidTagSmtpAddress`) instead.
 *
 *   node scripts/fixtures/build-msg-fixtures.mjs
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMsg } from './cfb-writer.mjs'
import { strProp, intProp, binProp, recipient, attachment, RECIP_TYPE } from './msg-props.mjs'
import * as V from './vocabulary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../tests/corpus')

const dn = (cn) => `/o=ExampleCorp/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=${cn}`

function message({ subject, senderName, senderEmail, senderSmtpAddress, recipients, bodyText, bodyHtml, attachments = [] }) {
  const children = [
    strProp('001A', 'IPM.Note'), // PidTagMessageClass
    strProp('0037', subject), // PidTagSubject
    strProp('0C1A', senderName), // PidTagSenderName
    strProp('0C1F', senderEmail), // PidTagSenderEmailAddress
    strProp('1000', bodyText), // PidTagBody
  ]
  if (senderSmtpAddress) children.push(strProp('5D01', senderSmtpAddress)) // PidTagSenderSmtpAddress
  if (bodyHtml) children.push(binProp('1013', Buffer.from(bodyHtml, 'utf8'))) // PidTagHtml
  recipients.forEach((r, i) => children.push(recipient(i, r)))
  attachments.forEach((a, i) => children.push(attachment(i, a)))
  return buildMsg(children)
}


/** A 2x2 PNG, the smallest thing that still decodes as an image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z4AATAxDVgQAF0oBc' +
    'c0Q3FIAAAAASUVORK5CYII=',
  'base64',
)

const person = (last) => V.PEOPLE.find((p) => p.last === last)
const [vellum, ferrow, ashcombe, larkspur, brandt, halloway, quill, sorrel] =
  ['Vellum', 'Ferrow', 'Ashcombe', 'Larkspur', 'Brandt', 'Halloway', 'Quill', 'Sorrel'].map(person)
const [floorplanGif, notesTxt, shelvingPng, aisleJpg] = V.MSG.attachments

const fixtures = [
  {
    // Exercises the inline-image path: an HTML body referencing its pictures by
    // cid, one attachment declaring its MIME type and one that does not — the
    // second forces the guessMime(fileName) fallback. The third is referenced by
    // bare filename rather than cid, which de-encapsulated Outlook HTML does.
    file: 'inline-images-thread.msg',
    subject: V.MSG.photos.subject,
    senderName: V.displayName(vellum),
    senderEmail: dn(vellum.dn),
    senderSmtpAddress: V.mailbox(vellum),
    bodyText: V.MSG.photos.body,
    bodyHtml:
      `<html><body><p>${V.MSG.photos.body}</p>` +
      '<p><img src="cid:shelving-1@example.com" alt="shelving"></p>' +
      '<p><img src="cid:aisle-2@example.com" alt="aisle"></p>' +
      `<p><img src="${floorplanGif}" alt="floorplan"></p>` +
      '<p><img src="cid:not-attached@example.com" alt="never sent"></p>' +
      '</body></html>',
    attachments: [
      { fileName: shelvingPng, contentId: 'shelving-1@example.com', mimeTag: 'image/png', bytes: PNG },
      // No mimeTag on purpose - the reader must guess it from ".jpg".
      { fileName: aisleJpg, contentId: 'aisle-2@example.com', bytes: PNG },
      // Referenced by filename, not cid.
      { fileName: floorplanGif, bytes: PNG },
      // Not an image, and must be left alone rather than inlined.
      { fileName: notesTxt, mimeTag: 'text/plain', bytes: Buffer.from('plain text') },
    ],
    recipients: [
      { name: V.displayName(ferrow), addressType: 'SMTP', email: V.mailbox(ferrow), recipType: RECIP_TYPE.to },
    ],
  },
  {
    file: 'internal-exchange-thread.msg',
    subject: V.MSG.status.subject,
    senderName: V.displayName(ashcombe),
    senderEmail: dn(ashcombe.dn),
    senderSmtpAddress: V.mailbox(ashcombe),
    bodyText: V.MSG.status.body,
    recipients: [
      { name: V.displayName(larkspur), addressType: 'EX', email: dn(larkspur.dn), smtpAddress: V.mailbox(larkspur), recipType: RECIP_TYPE.to },
      { name: V.displayName(brandt), addressType: 'EX', email: dn(brandt.dn), smtpAddress: V.mailbox(brandt), recipType: RECIP_TYPE.to },
      { name: V.displayName(halloway), addressType: 'SMTP', email: V.mailbox(halloway, V.DOMAINS.org), recipType: RECIP_TYPE.cc },
    ],
  },
  {
    file: 'distribution-list-thread.msg',
    subject: V.MSG.hours.subject,
    senderName: V.TEAM_NAME,
    senderEmail: dn('OPSCTR'),
    senderSmtpAddress: V.TEAM_MAILBOX,
    bodyText: V.MSG.hours.body,
    recipients: [
      { name: V.displayName(quill), addressType: 'EX', email: dn(quill.dn), smtpAddress: V.mailbox(quill), recipType: RECIP_TYPE.to },
    ],
  },
  {
    file: 'display-name-only-thread.msg',
    subject: V.MSG.design.subject,
    senderName: V.displayName(sorrel),
    senderEmail: dn(sorrel.dn),
    // No senderSmtpAddress at all: the msg genuinely carries no SMTP address,
    // which is the case the reader has to degrade gracefully for.
    senderSmtpAddress: undefined,
    bodyText: V.MSG.design.body,
    recipients: [],
  },
]

for (const f of fixtures) {
  const bytes = message(f)
  writeFileSync(join(OUT, f.file), bytes)
  console.log(`wrote ${f.file} (${bytes.length} bytes)`)
}
