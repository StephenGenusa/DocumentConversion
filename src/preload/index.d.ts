import type { ElectronAPI } from '@electron-toolkit/preload'
import type { Api } from './types'

export type {
  SourceFormat,
  TargetFormat,
  DetectResult,
  LoadedInput,
  SaveResult,
  Api,
  PdfOptions,
  PdfPageSize,
} from './types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
