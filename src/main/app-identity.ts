import { app } from 'electron'

/**
 * The name people see. It must match `productName` in electron-builder.yml
 * (tests/main/app-identity.test.ts holds the two together); package.json's
 * `name` is the lower-case package id, which is what app.getName() returns in
 * development, so it cannot be used for this.
 */
export const PRODUCT_NAME = 'Document Converter'

/**
 * The name Electron gives the app, and so its userData folder
 * (~/.config/docconversion, %APPDATA%\docconversion, ~/Library/Application
 * Support/docconversion): package.json's `productName`, else its `name`.
 * package.json has no productName, and electron-builder does not add one to
 * the packaged copy (checked in app.asar of the 1.3.0 build), so a packaged
 * build and `electron .` both use this. `electron out/main/index.js` has no
 * package.json beside it and is named "Electron"; the CLI pins userData to
 * this name so it finds what the window saved (index.ts).
 */
export const PACKAGE_NAME = 'docconversion'

/** "Document Converter 1.3.0": the version comes from package.json, as `--version` prints it. */
export function appTitle(): string {
  return `${PRODUCT_NAME} ${app.getVersion()}`
}
