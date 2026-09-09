/**
 * Source-file extension allowlist → highlight.js language names.
 *
 * Maps, not object literals. Both keys come off a filename, and a plain literal
 * inherits `Object.prototype`: a file named `constructor` looked up a FUNCTION,
 * which is truthy, so the converter routed it to the code reader and handed
 * highlight.js a function where a language name belongs. `__proto__` came back
 * as the prototype object itself.
 */
const EXT_TO_LANG = new Map<string, string>(
  Object.entries({
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    cs: 'csharp',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    ps1: 'powershell',
    psm1: 'powershell',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    json: 'json',
    xml: 'xml',
    css: 'css',
    scss: 'scss',
  }),
)

// .html/.htm deliberately route to the html reader as documents, never here.
const NAME_TO_LANG = new Map<string, string>(
  Object.entries({
    dockerfile: 'dockerfile',
    makefile: 'makefile',
  }),
)

export function languageForFilename(filename: string): string | null {
  const base = (filename.split(/[\\/]/).pop() ?? filename).toLowerCase()
  const byName = NAME_TO_LANG.get(base)
  if (byName) return byName
  const m = /\.([a-z0-9]+)$/i.exec(base)
  return m ? (EXT_TO_LANG.get(m[1]) ?? null) : null
}

export function codeFormatFromFilename(filename: string): boolean {
  return languageForFilename(filename) !== null
}
