import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectDriverStatus } from './driver-status'

const temporaryDirectories: string[] = []

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'adb-tool-driver-status-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('detectDriverStatus', () => {
  it('Windows 未携带驱动目录时只报告未内置驱动包', () => {
    const root = createTemporaryDirectory()

    expect(detectDriverStatus(join(root, 'missing'), 'win32')).toEqual({
      state: 'not-bundled',
      message: '安装包未内置目标触摸屏的已签名 Windows x64 OEM USB 驱动包。'
    })
  })

  it('同时存在 INF 与 CAT 时报告已内置 OEM 驱动包', () => {
    const root = createTemporaryDirectory()
    const driverDirectory = join(root, 'vendor')
    mkdirSync(driverDirectory)
    writeFileSync(join(driverDirectory, 'touchscreen.inf'), '')
    writeFileSync(join(driverDirectory, 'touchscreen.cat'), '')

    expect(detectDriverStatus(root, 'win32')).toEqual({
      state: 'package-detected',
      message: '安装包已内置 OEM USB 驱动包；仍需在目标 Windows 设备上验收签名与 VID/PID。'
    })
  })
})
