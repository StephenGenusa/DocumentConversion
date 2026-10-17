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
  | 'ocr-canceled'
  /** The user canceled: not a failure, and never reported as one. */
  | 'canceled'
  | 'eml-parse-failed'
  | 'msg-parse-failed'
  | 'rtf-parse-failed'
  | 'image-unsupported'
  | 'merge-empty'
  /** A file the app was given is no longer on disk to be read. */
  | 'source-missing'

export class ConversionError extends Error {
  constructor(
    public readonly code: ConversionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ConversionError'
  }
}
