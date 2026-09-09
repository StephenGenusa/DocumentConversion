import { ocrPdf, ocrImage } from '../ocr/pipeline'
import { ConversionError } from '../core/errors'

/**
 * utilityProcess entry: owns pdfjs + canvas + tesseract so CPU-bound
 * rasterization/recognition never blocks the main process's IPC broker.
 * Cancellation is the parent killing this process.
 */
interface OcrRequest {
  kind: 'pdf' | 'image'
  base64: string
  langPath: string
  language?: string
  gzip?: boolean
}

process.parentPort.on('message', (e) => {
  const req = e.data as OcrRequest
  const post = (msg: unknown): void => process.parentPort.postMessage(msg)
  const ctx = {
    onProgress: (stage: string, percent?: number) => post({ type: 'progress', stage, percent }),
  }
  const bytes = Buffer.from(req.base64, 'base64')
  const run =
    req.kind === 'pdf'
      ? ocrPdf(bytes, { langPath: req.langPath, language: req.language, gzip: req.gzip }, ctx)
      : ocrImage(bytes, { langPath: req.langPath, language: req.language, gzip: req.gzip }, ctx).then((page) => [page])
  run
    .then((pages) => post({ type: 'done', pages }))
    .catch((err) =>
      post({
        type: 'error',
        code: err instanceof ConversionError ? err.code : 'ocr-failed',
        message: (err as Error).message,
      }),
    )
})
