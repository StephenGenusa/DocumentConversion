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

// Compact GitHub-light palette for hljs spans. The pdf and html shell prints it
// inline (the shell must stay self-contained) and the editor colors code with it
// (renderer/src/lib/code-color.ts), so the pane looks like the printed page.
export const HLJS_CSS = `
${TOKEN_COLORS.map(([scopes, color]) => `  ${scopes.map((s) => `.hljs-${s}`).join(', ')} { color: ${color}; }`).join('\n')}
  .hljs-comment, .hljs-quote { font-style: italic; }
  .hljs-section, .hljs-name { font-weight: 600; }
  .hljs-addition { background: #dafbe1; }
  .hljs-deletion { background: #ffebe9; }
  /* A printed review reads by whole lines: color the line, not just its text. */
  .language-diff .hljs-addition, .language-diff .hljs-deletion { display: inline-block; width: 100%; }
`
