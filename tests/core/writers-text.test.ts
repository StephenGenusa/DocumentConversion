import { describe, it, expect } from 'vitest'
import { writeTxt } from '../../src/core/writers/txt'
import { writeMarkdown } from '../../src/core/writers/md'
import { writeHtml } from '../../src/core/writers/html'

describe('writeTxt', () => {
  it('produces plain text', async () => {
    const out = (await writeTxt({ html: '<h1>Title</h1><p>Para one</p>' })).toString('utf8')
    expect(out).toContain('Para one')
    expect(out).not.toContain('<')
  })
})

describe('writeMarkdown', () => {
  it('produces markdown with atx headings', async () => {
    const out = (await writeMarkdown({ html: '<h1>Title</h1><p>Hi <strong>x</strong></p>' })).toString('utf8')
    expect(out).toContain('# Title')
    expect(out).toContain('**x**')
  })
})

describe('writeHtml', () => {
  it('produces a full html document', async () => {
    const out = (await writeHtml({ html: '<p>x</p>', title: 'T' })).toString('utf8')
    expect(out).toContain('<!doctype html>')
    expect(out).toContain('<title>T</title>')
    expect(out).toContain('<p>x</p>')
  })
})
