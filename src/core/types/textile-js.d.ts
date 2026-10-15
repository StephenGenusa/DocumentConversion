declare module 'textile-js' {
  /** A JsonML node: text, or [tag, attributes?, ...children]. */
  type JsonML = string | [string, ...unknown[]]
  interface Textile {
    (text: string, options?: { breaks?: boolean }): string
    /** The parse tree, as ['html', ...blocks]. */
    jsonml(text: string, options?: { breaks?: boolean }): JsonML[]
    serialize(tree: JsonML): string
  }
  const textile: Textile
  export default textile
}
