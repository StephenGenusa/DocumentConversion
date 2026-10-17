/*
 * The screen palette for highlighted code, apart from highlight.js itself:
 * the pdf and html shell, revealjs and the docx writer use it through
 * core/hljs.ts, and the editor (renderer/src/lib/code-color.ts) imports it
 * from here so that the renderer does not carry every grammar.
 */

/**
 * The color of each highlight.js scope, GitHub-light. The pdf and html shell
 * turns this into CSS; the docx writer gives a run the color of its token.
 * None of these may begin `0D0C`: that is the docx writer's stand-in marker
 * for run formatting (writers/docx.ts), and a run colored like it would be
 * rewritten as bold or italic.
 */
export const TOKEN_COLORS: ReadonlyArray<readonly [scopes: readonly string[], color: string]> = [
  [['keyword', 'selector-tag', 'meta'], '#cf222e'],
  [['title'], '#8250df'],
  [['string', 'regexp', 'attr'], '#0a3069'],
  [['number', 'literal'], '#0550ae'],
  [['comment', 'quote'], '#59636e'],
  [['built_in', 'type'], '#953800'],
  [['variable', 'template-variable', 'property'], '#24292f'],
  [['section', 'name'], '#0550ae'],
]

/**
 * The same scopes for code on a dark ground, GitHub-dark: a revealjs deck
 * whose slide theme is dark (writers/revealjs.ts). Every color reads at AA
 * (4.5:1) or better on DARK_CODE_GROUND, as tests/core/code-palette-contrast
 * checks.
 */
export const DARK_TOKEN_COLORS: ReadonlyArray<readonly [scopes: readonly string[], color: string]> = [
  [['keyword', 'selector-tag', 'meta'], '#ff7b72'],
  [['title'], '#d2a8ff'],
  [['string', 'regexp', 'attr'], '#a5d6ff'],
  [['number', 'literal'], '#79c0ff'],
  [['comment', 'quote'], '#9ea7b3'],
  [['built_in', 'type'], '#ffa657'],
  [['variable', 'template-variable', 'property'], '#e6edf3'],
  [['section', 'name'], '#79c0ff'],
]

/** A code block's ground and plain text under DARK_TOKEN_COLORS. */
export const DARK_CODE_GROUND = '#22272e'
export const DARK_CODE_TEXT = '#e6edf3'

/** A screen palette as CSS; a diff's lines are tinted with `tints`. */
function paletteCss(
  colors: ReadonlyArray<readonly [scopes: readonly string[], color: string]>,
  tints: { addition: string; deletion: string },
): string {
  return `
${colors.map(([scopes, color]) => `  ${scopes.map((s) => `.hljs-${s}`).join(', ')} { color: ${color}; }`).join('\n')}
  .hljs-comment, .hljs-quote { font-style: italic; }
  .hljs-section, .hljs-name { font-weight: 600; }
  .hljs-addition { background: ${tints.addition}; }
  .hljs-deletion { background: ${tints.deletion}; }
  /* A printed review reads by whole lines: color the line, not just its text. */
  .language-diff .hljs-addition, .language-diff .hljs-deletion { display: inline-block; width: 100%; }
`
}

// Compact GitHub-light palette for hljs spans. The pdf and html shell prints it
// inline (the shell must stay self-contained) and the editor colors code with it
// (renderer/src/lib/code-color.ts), so the pane looks like the printed page.
export const HLJS_CSS = paletteCss(TOKEN_COLORS, { addition: '#dafbe1', deletion: '#ffebe9' })

/** The dark one, for a block on DARK_CODE_GROUND. */
export const HLJS_DARK_CSS = paletteCss(DARK_TOKEN_COLORS, { addition: '#033a16', deletion: '#67060c' })
