import { describe, expect, it } from 'vitest'
import { COMMAND_IDS } from '../shared/contracts'
import { COMMAND_CATALOG } from './command-catalog'

describe('内置命令注册表', () => {
  it('完整且没有重复命令', () => {
    const ids = COMMAND_CATALOG.map(({ id }) => id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.toSorted()).toEqual([...COMMAND_IDS].toSorted())
  })

  it('每个命令都声明风险、超时、输入依赖和结果类型', () => {
    for (const command of COMMAND_CATALOG) {
      expect(command.displayName.length).toBeGreaterThan(0)
      expect(command.timeoutMs).toBeGreaterThan(0)
      expect(['adb', 'shell', 'workflow']).toContain(command.type)
      expect(['safe', 'confirm', 'danger']).toContain(command.risk)
      expect([
        'exit-code',
        'success-token',
        'installed-version',
        'launcher-match',
        'device-reconnect'
      ]).toContain(command.resultParser)
      expect(Array.isArray(command.argumentTemplate)).toBe(true)
    }
  })

  it('不包含已明确排除的系统控制和安装时全量授权参数', () => {
    const allArguments = COMMAND_CATALOG.flatMap(({ argumentTemplate }) => argumentTemplate).join(' ')
    expect(allArguments).not.toMatch(/statusbar|KEYCODE_WAKEUP|KEYCODE_POWER|screencap/)
    expect(allArguments).not.toMatch(/(?:^|\s)-g(?:\s|$)/)
    expect(allArguments).not.toMatch(/device_owner|lock-task|lockTask/i)
  })
})
