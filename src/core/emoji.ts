/**
 * Chromium's printToPDF renders color emoji as monochrome outlines on some
 * platforms. Replace common status emoji with plain glyphs styled via CSS color
 * so PDFs keep their green/red meaning.
 */
const RULES: Record<string, { glyph: string; color: string }> = {
  '✅': { glyph: '✓', color: '#16a34a' }, // ✅ green check
  '✔': { glyph: '✓', color: '#16a34a' }, // ✔
  '☑': { glyph: '✓', color: '#16a34a' }, // ☑
  '❌': { glyph: '✗', color: '#dc2626' }, // ❌ red x
  '❎': { glyph: '✗', color: '#dc2626' }, // ❎
  '✖': { glyph: '✗', color: '#dc2626' }, // ✖
  '✗': { glyph: '✗', color: '#dc2626' }, // ✗
  '✘': { glyph: '✗', color: '#dc2626' }, // ✘
  '⚠': { glyph: '⚠', color: '#d97706' }, // ⚠ amber warning
  '\u{1F7E2}': { glyph: '●', color: '#16a34a' }, // 🟢
  '\u{1F534}': { glyph: '●', color: '#dc2626' }, // 🔴
  '\u{1F7E1}': { glyph: '●', color: '#d97706' }, // 🟡
  '\u{1F7E0}': { glyph: '●', color: '#ea580c' }, // 🟠
  '\u{1F535}': { glyph: '●', color: '#2563eb' }, // 🔵
  '\u{1F7E3}': { glyph: '●', color: '#9333ea' }, // 🟣
}

const PATTERN = new RegExp('(' + Object.keys(RULES).join('|') + ')\\uFE0F?', 'gu')

export function colorizeStatusEmoji(html: string): string {
  return html.replace(PATTERN, (match, emoji: string) => {
    const rule = RULES[emoji]
    if (!rule) return match
    // U+FE0E (text presentation selector) keeps the glyph from being swapped for a color emoji.
    return `<span style="color:${rule.color}">${rule.glyph}︎</span>`
  })
}
