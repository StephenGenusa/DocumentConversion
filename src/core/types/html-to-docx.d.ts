declare module 'html-to-docx' {
  /** Returns a docx file as a Buffer (Node) / Blob (browser). We only use Node. */
  export default function HTMLtoDOCX(
    htmlString: string,
    headerHTMLString?: string | null,
    documentOptions?: Record<string, unknown>,
    footerHTMLString?: string | null,
  ): Promise<Buffer | ArrayBuffer>
}
