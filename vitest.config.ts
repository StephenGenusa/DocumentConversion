import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'tests/core/ocr-*.test.ts'],
        },
      },
      {
        test: {
          name: 'ocr',
          environment: 'node',
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
