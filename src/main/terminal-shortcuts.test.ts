import { describe, expect, it } from 'vitest'
import { parse } from 'shell-quote'
import { buildShortcut, shortcutDefaults, SHORTCUT_CATEGORIES, TERMINAL_SHORTCUTS, type ShortcutParameter } from '../shared/terminal-shortcuts'
import { parseTerminalCommand } from './terminal-command'

const samples: Record<ShortcutParameter['kind'], string> = {
  package: 'com.example.app', component: 'com.example.app/.MainActivity', number: '30',
  port: '8080', remotePath: '/sdcard/Download/测试 file.txt', localPath: 'C:\\APK\\测试 file.apk', text: 'test value'
}
const valuesFor = (id: string) => Object.fromEntries(TERMINAL_SHORTCUTS.find((item) => item.id === id)!.parameters.map((p) => [p.key, p.defaultValue || samples[p.kind]]))
const shortcut = (id: string) => TERMINAL_SHORTCUTS.find((item) => item.id === id)!

describe('快捷命令库与真实执行入口的契约', () => {
  it('命令 ID 唯一且覆盖全部调试分类', () => {
    expect(new Set(TERMINAL_SHORTCUTS.map((item) => item.id)).size).toBe(TERMINAL_SHORTCUTS.length)
    for (const category of SHORTCUT_CATEGORIES) expect(TERMINAL_SHORTCUTS.filter((item) => item.category === category).length).toBeGreaterThan(3)
  })
  it.each(TERMINAL_SHORTCUTS.map((item) => [item.id, item] as const))('%s 生成的 ADB 命令可由实际执行层解析', (id, item) => {
    const command = buildShortcut(item, valuesFor(id))
    expect(command).not.toContain('{{')
    expect(() => parseTerminalCommand(command, 100, 24)).not.toThrow()
    if (item.scope === 'shell') expect(buildShortcut(item, valuesFor(id), 'shell')).toBe(command.slice('adb shell '.length))
    else expect(() => buildShortcut(item, valuesFor(id), 'shell')).toThrow('退出设备 Shell')
  })
  it('仅从真实上下文预填包名，不虚构目标应用', () => {
    expect(shortcutDefaults(shortcut('package-info'), null)).toEqual({ package: '' })
    expect(shortcutDefaults(shortcut('package-info'), 'com.real.app')).toEqual({ package: 'com.real.app' })
  })
  it('文件路径经过引用后完整保留，不成为额外参数或命令', () => {
    const local = 'C:\\APK\\a $x `whoami` "quoted".apk'
    const remote = "/sdcard/a' ; echo injected; #.txt"
    const push = buildShortcut(shortcut('push'), { local, remote })
    expect(parseTerminalCommand(push, 100, 24).args).toEqual(['push', local, remote])
    const read = buildShortcut(shortcut('read-file'), { remote })
    const parsed = parseTerminalCommand(read, 100, 24)
    expect(parse(parsed.args[2]!, {})).toEqual(['head', '-n', '200', remote])
  })
  it('拒绝占位包名、越界端口、非绝对路径和可执行换行', () => {
    expect(() => buildShortcut(shortcut('package-info'), { package: '' })).toThrow('填写')
    expect(() => buildShortcut(shortcut('package-info'), { package: 'a; reboot' })).toThrow('格式')
    expect(() => buildShortcut(shortcut('forward'), { localPort: '70000', remotePort: '80' })).toThrow('65535')
    expect(() => buildShortcut(shortcut('push'), { local: '-r', remote: '/sdcard/a' })).toThrow('绝对路径')
    expect(() => buildShortcut(shortcut('screenrecord'), { seconds: '181', remote: '/sdcard/a.mp4' })).toThrow('180')
    expect(() => buildShortcut(shortcut('search-logs'), { keyword: 'test\nreboot' })).toThrow('控制字符')
  })
})
