import type { AdbToolApi } from '../../shared/contracts'

declare global {
  interface Window {
    adbTool: AdbToolApi
  }
}

export {}
