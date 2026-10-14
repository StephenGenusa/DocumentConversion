import { app } from 'electron'

/**
 * The name people see. It must match `productName` in electron-builder.yml
 * (tests/main/app-identity.test.ts holds the two together); package.json's
 * `name` is the lower-case package id, which is what app.getName() returns in
 * development, so it cannot be used for this.
 */
export const PRODUCT_NAME = 'Document Converter'

/** "Document Converter 1.3.0": the version comes from package.json, as `--version` prints it. */
export function appTitle(): string {
  return `${PRODUCT_NAME} ${app.getVersion()}`
}
