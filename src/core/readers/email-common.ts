import { escapeHtml } from '../shell'

export interface EmailMeta {
  from?: string
  to?: string
  cc?: string
  date?: string
  subject?: string
}

export function renderEmailHeader(meta: EmailMeta): string {
  const rows: string[] = []
  const add = (label: string, value?: string): void => {
    if (value && value.trim()) rows.push(`<tr><td>${label}</td><td>${escapeHtml(value)}</td></tr>`)
  }
  add('From', meta.from)
  add('To', meta.to)
  add('Cc', meta.cc)
  add('Date', meta.date)
  add('Subject', meta.subject)
  return rows.length ? `<table><tbody>${rows.join('')}</tbody></table>` : ''
}

export function renderAttachmentList(attachments: { name: string; size?: number }[]): string {
  if (attachments.length === 0) return ''
  const rows = attachments
    .map(
      (a) =>
        `<tr><td>${escapeHtml(a.name)}</td><td>${a.size != null ? `${a.size} bytes` : ''}</td></tr>`,
    )
    .join('')
  return `<h3>Attachments (not converted)</h3><table><tbody>${rows}</tbody></table>`
}

export function textToParagraphs(text: string): string {
  const blocks = text.split(/\r?\n\r?\n+/).filter((b) => b.trim().length > 0)
  return blocks.map((b) => `<p>${escapeHtml(b.trim()).replace(/\r?\n/g, '<br>')}</p>`).join('\n')
}
