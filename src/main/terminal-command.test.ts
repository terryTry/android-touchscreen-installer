import { describe, expect, it } from 'vitest'
import { parseTerminalCommand } from './terminal-command'

const parse = (command: string) => parseTerminalCommand(command, 100, 24)

describe('ADB 终端命令解析', () => {
  it('接受完整命令和省略 adb 的命令，保留日志过滤表达式', () => {
    expect(parse('adb logcat *:E')).toEqual({ args: ['logcat', '*:E'], mode: 'command', requiresDevice: true })
    expect(parse('devices -l')).toMatchObject({ args: ['devices', '-l'], requiresDevice: false })
  })
  it('保留 Windows 路径、空格和中文，不展开本机变量', () => {
    expect(parse(String.raw`adb install "C:\Program Files\触摸屏.apk"`).args).toEqual(['install', String.raw`C:\Program Files\触摸屏.apk`])
    expect(parse('adb pull /sdcard/a "$HOME"').args).toEqual(['pull', '/sdcard/a', '$HOME'])
  })
  it('在设备端解析 Shell 引号、管道和变量', () => {
    expect(parse('adb shell echo "$PATH" | cat').args).toEqual(['shell', '-T', 'echo "$PATH" | cat'])
    expect(parse('adb shell "pm list packages"').args).toEqual(['shell', '-T', 'pm list packages'])
    expect(parse("adb shell 'echo \"$PATH\"'").args).toEqual(['shell', '-T', 'echo "$PATH"'])
  })
  it('启动带固定尺寸的持续设备 PTY', () => {
    expect(parse('adb shell')).toMatchObject({ mode: 'shell', requiresDevice: true })
    expect(parse('adb shell').args).toEqual(['shell', '-tt', 'stty cols 100 rows 24; export TERM=xterm-256color; exec /system/bin/sh -i'])
  })
  it.each([
    'adb -s other shell id', 'adb -P 5037 devices', 'adb kill-server',
    'adb connect 1.2.3.4', 'adb wait-for-device kill-server', 'adb server nodaemon',
    'adb logcat > output.txt', 'adb devices && whoami', 'adb logcat | cat',
    'adb install "missing.apk', 'adb devices\nadb reboot', 'adb shell -t',
    String.raw`adb install C:\temp\app.apk`
  ])('拒绝越过设备/Server 管理和本机 Shell 边界：%s', (command) => {
    expect(() => parse(command)).toThrow()
  })
})
