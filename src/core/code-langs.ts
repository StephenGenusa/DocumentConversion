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
    jsonc: 'json',
    json5: 'json',
    xml: 'xml',
    xsd: 'xml',
    xsl: 'xml',
    xslt: 'xml',
    csproj: 'xml',
    config: 'xml',
    plist: 'xml',
    css: 'css',
    scss: 'scss',
    // In highlight.js/lib/common.
    php: 'php',
    phtml: 'php',
    swift: 'swift',
    lua: 'lua',
    pl: 'perl',
    pm: 'perl',
    r: 'r',
    mm: 'objectivec',
    vb: 'vbnet',
    graphql: 'graphql',
    gql: 'graphql',
    less: 'less',
    kts: 'kotlin',
    wat: 'wasm',
    // Registered individually in shell.ts.
    scala: 'scala',
    groovy: 'groovy',
    gradle: 'groovy',
    dart: 'dart',
    hs: 'haskell',
    ex: 'elixir',
    exs: 'elixir',
    erl: 'erlang',
    clj: 'clojure',
    cljs: 'clojure',
    fs: 'fsharp',
    fsx: 'fsharp',
    ml: 'ocaml',
    jl: 'julia',
    vbs: 'vbscript',
    bat: 'dos',
    cmd: 'dos',
    cmake: 'cmake',
    proto: 'protobuf',
    asm: 'x86asm',
    s: 'x86asm',
    // Configuration, highlighted as INI.
    env: 'ini',
    properties: 'ini',
    conf: 'ini',
    cfg: 'ini',
    editorconfig: 'ini',
    gitconfig: 'ini',
    npmrc: 'ini',
    // Patches: one section per file, see readers/code.ts.
    diff: 'diff',
    patch: 'diff',
    // .m is deliberately absent: it is Objective-C and MATLAB both, and a
    // guess prints one of them in the other's colors.
  }),
)

// .html/.htm deliberately route to the html reader as documents, never here.
const NAME_TO_LANG = new Map<string, string>(
  Object.entries({
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    'cmakelists.txt': 'cmake',
    'nginx.conf': 'nginx',
  }),
)

/** `.env.local`, `.env.production`: the extension is not the type. */
const ENV_FILE = /^\.env(\.[\w-]+)?$/

export function languageForFilename(filename: string): string | null {
  const base = (filename.split(/[\\/]/).pop() ?? filename).toLowerCase()
  const byName = NAME_TO_LANG.get(base)
  if (byName) return byName
  if (ENV_FILE.test(base)) return 'ini'
  const m = /\.([a-z0-9]+)$/i.exec(base)
  return m ? (EXT_TO_LANG.get(m[1]) ?? null) : null
}

export function codeFormatFromFilename(filename: string): boolean {
  return languageForFilename(filename) !== null
}

/**
 * A file the code reader owns by its whole NAME, which outranks its
 * extension: CMakeLists.txt is CMake, not plain text, and `.env.local` is
 * configuration. Checked before the extension map in detect.ts.
 */
export function codeNameFromFilename(filename: string): boolean {
  const base = (filename.split(/[\\/]/).pop() ?? filename).toLowerCase()
  return NAME_TO_LANG.has(base) || ENV_FILE.test(base)
}

