export type ConversionErrorCode =
  | 'scanned-pdf'
  | 'read-failed'
  | 'write-failed'
  | 'unsupported'
  | 'no-tables'
  | 'table-too-large'
  | 'fetch-failed'
  | 'fetch-too-large'
  | 'fetch-blocked'
  | 'extract-failed'
  | 'ocr-failed'
  | 'ocr-cancelled'
  /** The user cancelled: not a failure, and never reported as one. */
  | 'cancelled'
  | 'eml-parse-failed'
  | 'msg-parse-failed'
  | 'rtf-parse-failed'
  | 'image-unsupported'
  | 'merge-empty'

export class ConversionError extends Error {
  constructor(
    public readonly code: ConversionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ConversionError'
  }
}
