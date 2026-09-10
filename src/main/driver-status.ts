import { existsSync, readdirSync } from 'node:fs'
import type { DriverStatus } from '../shared/contracts'

export function detectDriverStatus(directory: string, platform: NodeJS.Platform): DriverStatus {
  if (platform !== 'win32') {
    return {
      state: 'not-applicable',
      message: 'macOS 开发模式使用本机 ADB；USB 驱动只在 Windows 验收。'
    }
  }

  if (!existsSync(directory)) {
    return {
      state: 'not-bundled',
      message: '安装包未内置目标触摸屏的已签名 Windows x64 OEM USB 驱动包。'
    }
  }

  const files = readdirSync(directory, { recursive: true }).map(String)
  const hasInf = files.some((file) => file.toLowerCase().endsWith('.inf'))
  const hasCatalog = files.some((file) => file.toLowerCase().endsWith('.cat'))

  if (!hasInf || !hasCatalog) {
    return {
      state: 'not-bundled',
      message: '安装包未内置同时包含 INF 与 CAT 的已签名 OEM USB 驱动包。'
    }
  }

  return {
    state: 'package-detected',
    message: '安装包已内置 OEM USB 驱动包；仍需在目标 Windows 设备上验收签名与 VID/PID。'
  }
}
