import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * Load pdfjs with an explicit workerSrc. In dev and in tests pdfjs finds its
 * fake-worker module on its own; inside a packaged app (main process or a
 * utilityProcess) that self-resolution fails against the asar layout with
 * "No GlobalWorkerOptions.workerSrc specified". pdfjs-dist ships asarUnpacked,
 * so point at the real file explicitly.
 */
export async function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const req = createRequire(__filename)
    const workerPath = req
      .resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
      .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href
  }
  return pdfjs
}
