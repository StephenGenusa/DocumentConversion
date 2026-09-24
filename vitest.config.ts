import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          // The first test in a file to touch pdf.js, pdf-lib, the docx writer
          // or the whole converter pays that module's import cost, and with
          // the suite running every worker at once that cost passed the
          // 5-second default on a Windows laptop: four tests failed on timing
          // alone and passed when run by themselves. A hang still fails, just
          // later.
          testTimeout: 30_000,
          include: ['tests/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'tests/core/ocr-*.test.ts'],
        },
      },
      {
        test: {
          name: 'ocr',
          environment: 'node',
          testTimeout: 30_000,
          include: ['tests/core/ocr-*.test.ts'],
          // tesseract's wasm threads crash the default fork pool at process
          // exit on Windows (tests pass, fork exit code is non-zero);
          // the threads pool tears down cleanly.
          pool: 'threads',
        },
      },
    ],
  },
})
