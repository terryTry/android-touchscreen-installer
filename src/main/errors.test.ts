import { describe, expect, it } from 'vitest'
import { mapAdbError } from './errors'

describe('ADB 错误中文映射', () => {
  it.each([
    ['INSTALL_FAILED_VERSION_DOWNGRADE', '不允许降级'],
    ['INSTALL_FAILED_UPDATE_INCOMPATIBLE', '签名不一致'],
    ['INSTALL_FAILED_INSUFFICIENT_STORAGE', '存储空间不足'],
    ['INSTALL_FAILED_OLDER_SDK', '低于 APK'],
    ['INSTALL_FAILED_NO_MATCHING_ABIS', 'CPU 架构不兼容'],
    ['INSTALL_PARSE_FAILED_MANIFEST_MALFORMED', 'Manifest 无法解析'],
    ['adb: error: failed to read copy response', 'adbd 拒绝文件传输'],
    ['error: device offline', '连接已中断'],
    ["failed to connect to '192.168.1.20:5555': No route to host", 'TCP/IP 连接失败'],
    ['error: unauthorized', '尚未授权'],
    ['error: no devices/emulators found', '未检测到可用设备']
  ])('将 %s 映射为现场人员可理解的提示', (input, expected) => {
    expect(mapAdbError(input, '失败').summary).toContain(expected)
  })

  it('未知错误保留具体操作上下文', () => {
    expect(mapAdbError('unexpected', '启动应用失败').summary).toBe('启动应用失败')
  })
})
