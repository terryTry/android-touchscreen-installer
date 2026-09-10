import type { CommandCatalogEntry, CommandId } from '../shared/contracts'

const catalog: CommandCatalogEntry[] = [
  {
    id: 'nav.back',
    displayName: '返回',
    type: 'shell',
    argumentTemplate: ['input', 'keyevent', 'KEYCODE_BACK'],
    resultParser: 'exit-code',
    risk: 'safe',
    timeoutMs: 10_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: false
  },
  {
    id: 'nav.home',
    displayName: 'Home',
    type: 'shell',
    argumentTemplate: ['input', 'keyevent', 'KEYCODE_HOME'],
    resultParser: 'exit-code',
    risk: 'safe',
    timeoutMs: 10_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: false
  },
  {
    id: 'nav.recents',
    displayName: '最近任务',
    type: 'shell',
    argumentTemplate: ['input', 'keyevent', 'KEYCODE_APP_SWITCH'],
    resultParser: 'exit-code',
    risk: 'safe',
    timeoutMs: 10_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: false
  },
  {
    id: 'app.install',
    displayName: '安装 / 更新',
    type: 'workflow',
    argumentTemplate: ['push', '<APK>', '<临时路径>', 'pm', 'install', '-r', '[-d]'],
    resultParser: 'installed-version',
    risk: 'confirm',
    timeoutMs: 300_000,
    requiresDevice: true,
    requiresApk: true,
    requiresPackage: true
  },
  {
    id: 'app.replace',
    displayName: '卸载旧版并重装',
    type: 'workflow',
    argumentTemplate: [
      'push',
      '<APK>',
      '→',
      'uninstall',
      '<包名>',
      '→',
      'pm',
      'install',
      '→',
      '验证版本'
    ],
    resultParser: 'installed-version',
    risk: 'danger',
    timeoutMs: 300_000,
    requiresDevice: true,
    requiresApk: true,
    requiresPackage: true
  },
  {
    id: 'app.deploySystem',
    displayName: '部署为系统应用',
    type: 'workflow',
    argumentTemplate: ['验证 Root 通道', '→', 'remount', '→', '/system/app 或 /system/priv-app', '→', 'reboot', '→', '验证'],
    resultParser: 'device-reconnect',
    risk: 'danger',
    timeoutMs: 360_000,
    requiresDevice: true,
    requiresApk: true,
    requiresPackage: true
  },
  {
    id: 'app.rollbackSystem',
    displayName: '回滚系统应用部署',
    type: 'workflow',
    argumentTemplate: ['验证 Root 通道', '→', 'remount', '→', '删除工具托管文件', '→', 'reboot', '→', '验证'],
    resultParser: 'device-reconnect',
    risk: 'danger',
    timeoutMs: 300_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: true
  },
  {
    id: 'app.launch',
    displayName: '启动应用',
    type: 'shell',
    argumentTemplate: ['am', 'start', '-n', '<组件名>'],
    resultParser: 'exit-code',
    risk: 'safe',
    timeoutMs: 20_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: true
  },
  {
    id: 'app.stop',
    displayName: '停止应用',
    type: 'shell',
    argumentTemplate: ['am', 'force-stop', '<包名>'],
    resultParser: 'exit-code',
    risk: 'confirm',
    timeoutMs: 15_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: true
  },
  {
    id: 'app.restart',
    displayName: '重启应用',
    type: 'workflow',
    argumentTemplate: ['am', 'force-stop', '<包名>', '→', 'am', 'start', '-n', '<组件名>'],
    resultParser: 'exit-code',
    risk: 'confirm',
    timeoutMs: 30_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: true
  },
  {
    id: 'app.uninstall',
    displayName: '卸载应用',
    type: 'workflow',
    argumentTemplate: [
      '识别普通/系统应用',
      '→',
      '清除数据',
      '→',
      '[Root + remount + 精确删除系统目录 + reboot]',
      '→',
      '验证包记录'
    ],
    resultParser: 'device-reconnect',
    risk: 'danger',
    timeoutMs: 360_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: true
  },
  {
    id: 'app.clearData',
    displayName: '清除应用数据',
    type: 'shell',
    argumentTemplate: ['pm', 'clear', '<包名>'],
    resultParser: 'success-token',
    risk: 'danger',
    timeoutMs: 30_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: true
  },
  {
    id: 'launcher.set',
    displayName: '设为开机应用',
    type: 'workflow',
    argumentTemplate: ['cmd', 'package', 'set-home-activity', '--user', '0', '<HOME 组件>'],
    resultParser: 'launcher-match',
    risk: 'confirm',
    timeoutMs: 45_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: true
  },
  {
    id: 'launcher.verify',
    displayName: '验证开机应用',
    type: 'workflow',
    argumentTemplate: ['cmd', 'package', 'resolve-activity', '--brief', '--user', '0', '<HOME Intent>'],
    resultParser: 'launcher-match',
    risk: 'safe',
    timeoutMs: 20_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: true
  },
  {
    id: 'launcher.rebootVerify',
    displayName: '重启并验证',
    type: 'workflow',
    argumentTemplate: ['reboot', '→', 'wait-for-device', '→', 'resolve-activity'],
    resultParser: 'launcher-match',
    risk: 'confirm',
    timeoutMs: 240_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: true
  },
  {
    id: 'launcher.restore',
    displayName: '恢复系统桌面',
    type: 'workflow',
    argumentTemplate: ['cmd', 'package', 'set-home-activity', '--user', '0', '<原 HOME 组件>'],
    resultParser: 'launcher-match',
    risk: 'confirm',
    timeoutMs: 45_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: false
  },
  {
    id: 'device.reboot',
    displayName: '重启设备',
    type: 'adb',
    argumentTemplate: ['reboot'],
    resultParser: 'device-reconnect',
    risk: 'confirm',
    timeoutMs: 180_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: false
  },
  {
    id: 'device.rootAccess',
    displayName: '获取 Root 权限',
    type: 'workflow',
    argumentTemplate: ['adb root', '或', 'su 0', '→', 'id 回读验证'],
    resultParser: 'device-reconnect',
    risk: 'danger',
    timeoutMs: 60_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: false
  },
  {
    id: 'system.settings',
    displayName: '系统设置',
    type: 'shell',
    argumentTemplate: ['am', 'start', '-a', 'android.settings.SETTINGS'],
    resultParser: 'exit-code',
    risk: 'safe',
    timeoutMs: 20_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: false
  },
  {
    id: 'system.developerSettings',
    displayName: '开发者选项',
    type: 'workflow',
    argumentTemplate: [
      'settings',
      'get',
      'global',
      'development_settings_enabled',
      '→',
      'am',
      'start',
      '-a',
      '<开发者选项 / 关于设备 / 系统设置>'
    ],
    resultParser: 'exit-code',
    risk: 'safe',
    timeoutMs: 20_000,
    requiresDevice: true,
    requiresApk: false,
    requiresPackage: false
  }
]

export const COMMAND_CATALOG: CommandCatalogEntry[] = catalog

export const COMMAND_BY_ID = new Map<CommandId, CommandCatalogEntry>(
  catalog.map((entry) => [entry.id, entry])
)
