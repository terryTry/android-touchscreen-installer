import { parse } from 'shell-quote'

const SERVER_COMMANDS = new Set([
  'start-server', 'kill-server', 'server', 'nodaemon', 'fork-server',
  'connect', 'disconnect', 'pair', 'reconnect', 'attach', 'detach'
])
const GLOBAL_COMMANDS = new Set(['devices', 'version', 'help', 'host-features', 'server-status', 'mdns'])
const DEVICE_COMMANDS = new Set([
  'logcat', 'install', 'install-multiple', 'install-multi-package', 'uninstall',
  'push', 'pull', 'bugreport', 'jdwp', 'get-state', 'get-serialno', 'get-devpath',
  'root', 'unroot', 'remount', 'reboot', 'usb', 'tcpip', 'forward', 'reverse',
  'features', 'disable-verity', 'enable-verity'
])

function checkQuotes(source: string): void {
  let quote: string | null = null
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '\\' && quote !== "'") {
      if (index === source.length - 1) throw new Error('命令末尾的反斜杠需要转义或放入引号中。')
      index++
    } else if (char === quote) quote = null
    else if (!quote && (char === '"' || char === "'")) quote = char
  }
  if (quote) throw new Error('命令中的引号未闭合。')
}

export interface ParsedTerminalCommand {
  args: string[]
  mode: 'command' | 'shell'
  requiresDevice: boolean
}

export function parseTerminalCommand(command: string, cols: number, rows: number): ParsedTerminalCommand {
  if (!command.trim() || command.length > 8192 || /[\x00-\x1f\x7f]/.test(command)) {
    throw new Error('请输入一条 ADB 命令（最多 8192 字符）。')
  }
  const source = command.trim().replace(/^adb(?:\.exe)?\s+/i, '')
  const head = source.match(/^([a-z][a-z0-9-]*)(?:\s|$)/)?.[1]
  if (!head || head === 'adb') throw new Error('请输入 adb 命令；设备和 Server 参数由应用自动设置。')
  if (SERVER_COMMANDS.has(head)) {
    throw new Error('连接和 ADB Server 生命周期由应用管理，请使用设备连接或修复入口。')
  }
  if (head === 'shell') {
    const remote = source.slice(head.length).trim()
    if (!remote) {
      return {
        args: ['shell', '-tt', `stty cols ${cols} rows ${rows}; export TERM=xterm-256color; exec /system/bin/sh -i`],
        mode: 'shell', requiresDevice: true
      }
    }
    if (remote.startsWith('-')) throw new Error('Shell 模式由终端管理；请直接输入 adb shell 或 adb shell <设备命令>。')
    // 保留设备端引号、变量与管道，交给设备 Shell 解析。
    checkQuotes(remote)
    const quoted = parse(remote, (name) => `$${name}`)
    const remoteCommand = /^["']/.test(remote) && quoted.length === 1 && typeof quoted[0] === 'string'
      ? quoted[0] : remote
    return { args: ['shell', '-T', remoteCommand], mode: 'command', requiresDevice: true }
  }
  if (!GLOBAL_COMMANDS.has(head) && !DEVICE_COMMANDS.has(head)) {
    throw new Error('当前终端不支持该 ADB 子命令；支持 shell、logcat、安装、文件传输、设备控制和查询命令。')
  }
  checkQuotes(source)
  if (/(?:^|\s)[a-z]:\\/i.test(source)) throw new Error('Windows 文件路径请用双引号包裹，例如 "C:\\APK\\app.apk"。')
  // 不展开本机环境变量，不执行本机管道、重定向或命令串联。
  const tokens = parse(source, (name) => `$${name}`).map((token) =>
    typeof token === 'object' && 'op' in token && token.op === 'glob' ? token.pattern : token)
  if (tokens.some((token) => typeof token !== 'string')) {
    throw new Error('不支持本机管道、重定向和命令串联；设备端管道请放在 adb shell 后。')
  }
  return { args: tokens as string[], mode: 'command', requiresDevice: !GLOBAL_COMMANDS.has(head) }
}
