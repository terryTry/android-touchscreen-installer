export const SHORTCUT_CATEGORIES = ['连接诊断', '设备信息', '应用管理', '日志排障', '网络调试', '文件传输', '显示与输入', '性能与系统'] as const
export type ShortcutCategory = typeof SHORTCUT_CATEGORIES[number]
export interface ShortcutParameter {
  key: string
  label: string
  kind: 'package' | 'component' | 'number' | 'port' | 'remotePath' | 'localPath' | 'text'
  placeholder: string
  defaultValue?: string
}
export interface TerminalShortcut {
  id: string
  category: ShortcutCategory
  title: string
  description: string
  scope: 'adb' | 'shell'
  template: string
  parameters: ShortcutParameter[]
  effect?: string
  note?: string
}
const pkg: ShortcutParameter = { key: 'package', label: '应用包名', kind: 'package', placeholder: 'com.example.app' }
const local: ShortcutParameter = { key: 'local', label: '本机绝对路径', kind: 'localPath', placeholder: 'C:\\APK\\app.apk 或 /Users/…/app.apk' }
const remote: ShortcutParameter = { key: 'remote', label: '设备绝对路径', kind: 'remotePath', placeholder: '/sdcard/Download/file.txt' }
const number = (key: string, label: string, defaultValue: string): ShortcutParameter => ({ key, label, kind: 'number', placeholder: defaultValue, defaultValue })
const text = (key: string, label: string, placeholder: string): ShortcutParameter => ({ key, label, kind: 'text', placeholder })
const port = (key: string, label: string): ShortcutParameter => ({ key, label, kind: 'port', placeholder: '8080' })
const command = (id: string, category: ShortcutCategory, title: string, description: string, scope: 'adb' | 'shell', template: string,
  parameters: ShortcutParameter[] = [], options: Pick<TerminalShortcut, 'effect' | 'note'> = {}): TerminalShortcut =>
  ({ id, category, title, description, scope, template, parameters, ...options })

export const TERMINAL_SHORTCUTS: TerminalShortcut[] = [
  command('devices', '连接诊断', '设备列表', '检查已连接、离线和未授权设备。', 'adb', 'devices -l'),
  command('version', '连接诊断', 'ADB 版本', '查看本机 ADB 版本和安装路径。', 'adb', 'version'),
  command('help', '连接诊断', 'ADB 帮助', '查看 ADB 原生帮助；连接与 Server 启停仍由应用管理。', 'adb', 'help'),
  command('mdns', '连接诊断', '无线调试发现', '发现局域网 mDNS 无线调试服务。', 'adb', 'mdns services', [], { note: '依赖 ADB 版本、网络与设备的无线调试支持。' }),
  command('state', '连接诊断', '设备连接状态', '读取当前目标设备的连接状态。', 'adb', 'get-state'),
  command('serial', '连接诊断', '设备序列号', '确认当前操作目标。', 'adb', 'get-serialno'),
  command('shell', '连接诊断', '进入设备 Shell', '进入持续交互会话，保留目录和变量；exit 退出。', 'adb', 'shell'),
  command('getprop', '设备信息', '全部系统属性', '读取型号、固件、ABI 等系统属性。', 'shell', 'getprop'),
  command('model', '设备信息', '设备型号', '读取产品型号。', 'shell', 'getprop ro.product.model'),
  command('android', '设备信息', 'Android 版本', '读取 Android 系统版本。', 'shell', 'getprop ro.build.version.release'),
  command('sdk', '设备信息', 'Android API 等级', '读取 SDK API 等级，判断命令和权限适用性。', 'shell', 'getprop ro.build.version.sdk'),
  command('abi', '设备信息', 'CPU 架构', '查看设备支持的 ABI 列表。', 'shell', 'getprop ro.product.cpu.abilist'),
  command('identity', '设备信息', '当前权限身份', '查看 shell/adbd 的 uid、gid，确认是否为 root。', 'shell', 'id'),
  command('selinux', '设备信息', 'SELinux 状态', '查看 Enforcing 或 Permissive 模式。', 'shell', 'getenforce'),
  command('date', '设备信息', '设备时间', '读取设备时间和时区。', 'shell', 'date'),
  command('uptime', '设备信息', '运行时长', '查看开机时长和系统负载。', 'shell', 'uptime'),
  command('battery', '设备信息', '电池与供电', '查看电量、供电和温度。', 'shell', 'dumpsys battery'),
  command('packages', '应用管理', '全部应用包名', '列出设备已安装应用。', 'shell', 'pm list packages'),
  command('third-party', '应用管理', '第三方应用', '只列出用户安装的应用。', 'shell', 'pm list packages -3'),
  command('system-apps', '应用管理', '系统应用', '只列出系统应用。', 'shell', 'pm list packages -s'),
  command('disabled-apps', '应用管理', '已停用应用', '检查被禁用的包。', 'shell', 'pm list packages -d'),
  command('package-info', '应用管理', '应用详情与权限', '查看版本、组件、权限和安装状态。', 'shell', 'dumpsys package {{package}}', [pkg]),
  command('package-path', '应用管理', 'APK 安装路径', '查看主 APK 与 split APK 的实际路径。', 'shell', 'pm path {{package}}', [pkg]),
  command('launch', '应用管理', '启动应用', '通过 LAUNCHER 入口启动指定应用。', 'shell', 'monkey -p {{package}} -c android.intent.category.LAUNCHER 1', [pkg], { effect: '会启动应用。', note: '应用需要提供可启动的 LAUNCHER Activity。' }),
  command('activity', '应用管理', '启动指定 Activity', '指定包名/组件，查看启动耗时。', 'shell', 'am start -W -n {{component}}', [{ key: 'component', label: 'Activity 组件', kind: 'component', placeholder: 'com.example.app/.MainActivity' }], { effect: '会启动指定页面。' }),
  command('stop-app', '应用管理', '强制停止应用', '停止应用及其进程。', 'shell', 'am force-stop {{package}}', [pkg], { effect: '会中断应用当前任务。' }),
  command('install', '应用管理', '安装或覆盖 APK', '从本机安装 APK，-r 保留已有应用数据。', 'adb', 'install -r {{local}}', [local], { effect: '会安装或更新应用。' }),
  command('clear-data', '应用管理', '清除应用数据', '清除指定应用的全部本地数据。', 'shell', 'pm clear {{package}}', [pkg], { effect: '会永久删除该应用的数据与登录状态。' }),
  command('uninstall', '应用管理', '卸载应用', '卸载指定应用。', 'adb', 'uninstall {{package}}', [pkg], { effect: '会删除应用及其数据；系统应用建议使用主界面的专用流程。' }),
  command('enable-app', '应用管理', '启用应用', '恢复当前用户的应用启用状态。', 'shell', 'pm enable {{package}}', [pkg], { effect: '会修改应用启用状态。' }),
  command('disable-app', '应用管理', '停用应用', '对用户 0 禁用指定包。', 'shell', 'pm disable-user --user 0 {{package}}', [pkg], { effect: '会使应用无法运行；停用桌面或系统关键包可能影响设备使用。' }),
  command('logcat', '日志排障', '实时日志', '按 threadtime 格式持续读取日志；Ctrl+C 停止。', 'shell', 'logcat -v threadtime'),
  command('recent-logs', '日志排障', '最近 300 行日志', '读取已有日志后立即返回。', 'shell', 'logcat -d -t 300 -v threadtime'),
  command('error-logs', '日志排障', '错误级别日志', '只持续显示 Error 与 Fatal 日志。', 'shell', 'logcat -v threadtime *:E'),
  command('crash-logs', '日志排障', '崩溃日志', '读取 crash 缓冲区，排查闪退。', 'shell', 'logcat -b crash -d -v threadtime'),
  command('tag-logs', '日志排障', '按 Tag 查看日志', '仅显示指定 Tag 的 Verbose 及以上日志。', 'shell', 'logcat -v threadtime {{tag}}:V *:S', [text('tag', '日志 Tag', 'ActivityManager')]),
  command('pid-logs', '日志排障', '按 PID 查看日志', '持续查看指定进程日志，PID 可用“应用进程 PID”查询。', 'shell', 'logcat --pid={{pid}} -v threadtime', [number('pid', '进程 PID', '')], { note: '需要支持 --pid 的 Android Logcat；应用重启后 PID 会变化。' }),
  command('search-logs', '日志排障', '搜索日志关键字', '从现有日志中查找文字后返回。', 'shell', 'logcat -d -v threadtime | grep -F -e {{keyword}}', [text('keyword', '日志关键字', 'Exception')]),
  command('pid', '日志排障', '应用进程 PID', '查找指定包对应的运行进程。', 'shell', 'pidof {{package}}', [pkg]),
  command('clear-logs', '日志排障', '清空日志缓冲区', '清除旧日志，便于重新复现问题。', 'shell', 'logcat -c', [], { effect: '会删除当前日志缓冲区中的排障记录。' }),
  command('bugreport', '日志排障', '导出完整诊断报告', '将 bugreport 保存到本机指定路径。', 'adb', 'bugreport {{local}}', [{ ...local, placeholder: 'C:\\Logs\\bugreport.zip 或 /tmp/bugreport.zip' }], { effect: '会写入本机文件，报告可能包含设备和应用信息。', note: '生成报告可能耗时较长。' }),
  command('ip', '网络调试', 'IP 与网卡', '查看 Wi-Fi、以太网等接口和 IP 地址。', 'shell', 'ip addr show'),
  command('route', '网络调试', '路由与网关', '检查默认路由和网关。', 'shell', 'ip route show'),
  command('wifi', '网络调试', 'Wi-Fi 状态', '查看 Wi-Fi 服务的连接与配置诊断。', 'shell', 'dumpsys wifi'),
  command('connectivity', '网络调试', '系统网络状态', '查看默认网络、网络能力和连接状态。', 'shell', 'dumpsys connectivity'),
  command('ping', '网络调试', 'Ping 连通性', '从设备向指定地址发送 4 次探测。', 'shell', 'ping -c 4 {{host}}', [text('host', 'IP 或域名', '192.168.1.1')]),
  command('sockets', '网络调试', 'TCP/UDP 监听端口', '查看设备监听的 socket。', 'shell', 'ss -lntu', [], { note: '部分固件没有 ss，或会限制 socket 信息读取。' }),
  command('forward-list', '网络调试', '本机端口转发列表', '查看 ADB forward 转发规则。', 'adb', 'forward --list'),
  command('forward', '网络调试', '本机转发到设备', '将本机 TCP 端口转发到设备端口。', 'adb', 'forward tcp:{{localPort}} tcp:{{remotePort}}', [port('localPort', '本机端口'), port('remotePort', '设备端口')], { effect: '会新增或替换本机端口转发。' }),
  command('reverse-list', '网络调试', '设备反向转发列表', '查看 ADB reverse 转发规则。', 'adb', 'reverse --list'),
  command('reverse', '网络调试', '设备访问本机端口', '将设备 TCP 端口转发到本机开发服务。', 'adb', 'reverse tcp:{{remotePort}} tcp:{{localPort}}', [port('remotePort', '设备端口'), port('localPort', '本机端口')], { effect: '会新增或替换设备反向转发。' }),
  command('forward-remove', '网络调试', '移除本机端口转发', '移除一个 forward TCP 端口规则。', 'adb', 'forward --remove tcp:{{localPort}}', [port('localPort', '本机端口')], { effect: '会中断使用该规则的连接。' }),
  command('reverse-remove', '网络调试', '移除设备反向转发', '移除一个 reverse TCP 端口规则。', 'adb', 'reverse --remove tcp:{{remotePort}}', [port('remotePort', '设备端口')], { effect: '会中断使用该规则的连接。' }),
  command('files', '文件传输', '列出目录', '查看设备目录内容、权限和大小。', 'shell', 'ls -la {{remote}}', [{ ...remote, defaultValue: '/sdcard/' }]),
  command('read-file', '文件传输', '读取文本文件', '显示设备文件的前 200 行。', 'shell', 'head -n 200 {{remote}}', [remote], { note: '适合文本文件；不要用于 APK、图片等二进制文件。' }),
  command('disk', '文件传输', '磁盘空间', '检查分区容量和剩余空间。', 'shell', 'df -h'),
  command('directory-size', '文件传输', '目录占用', '统计指定设备目录的空间占用。', 'shell', 'du -sh {{remote}}', [{ ...remote, defaultValue: '/sdcard/Download' }]),
  command('push', '文件传输', '推送文件到设备', '从本机复制文件或目录到设备。', 'adb', 'push {{local}} {{remote}}', [local, remote], { effect: '目标同名文件可能被覆盖。' }),
  command('pull', '文件传输', '拉取文件到本机', '从设备复制文件或目录到本机。', 'adb', 'pull {{remote}} {{local}}', [remote, local], { effect: '本机同名文件可能被覆盖。' }),
  command('screenshot', '文件传输', '截图保存到设备', '生成 PNG 到设备路径，再用“拉取文件到本机”导出。', 'shell', 'screencap -p {{remote}}', [{ ...remote, defaultValue: '/sdcard/screenshot.png' }], { effect: '会写入设备文件，同名文件可能被覆盖。' }),
  command('screenrecord', '文件传输', '录屏保存到设备', '录制指定秒数，再用 pull 导出。', 'shell', 'screenrecord --time-limit {{seconds}} {{remote}}', [number('seconds', '录制秒数（1–180）', '30'), { ...remote, defaultValue: '/sdcard/screenrecord.mp4' }], { effect: '会写入设备视频文件。', note: '部分设备不支持录屏；也可在持续 Shell 中 Ctrl+C 提前结束。' }),
  command('resolution', '显示与输入', '屏幕分辨率', '读取物理分辨率和覆盖值。', 'shell', 'wm size'),
  command('density', '显示与输入', '屏幕密度', '读取物理 DPI 和覆盖值。', 'shell', 'wm density'),
  command('set-resolution', '显示与输入', '设置逻辑分辨率', '临时调整显示尺寸，可用“恢复分辨率”还原。', 'shell', 'wm size {{width}}x{{height}}', [number('width', '宽度 px', '1280'), number('height', '高度 px', '720')], { effect: '会改变设备显示布局，数值不合适可能影响操作。' }),
  command('reset-resolution', '显示与输入', '恢复分辨率', '移除逻辑分辨率覆盖值。', 'shell', 'wm size reset', [], { effect: '会恢复固件默认显示尺寸。' }),
  command('reset-density', '显示与输入', '恢复屏幕密度', '移除屏幕 DPI 覆盖值。', 'shell', 'wm density reset', [], { effect: '会恢复固件默认显示密度。' }),
  command('home', '显示与输入', 'Home 键', '返回设备桌面。', 'shell', 'input keyevent KEYCODE_HOME', [], { effect: '会切换前台页面。' }),
  command('back', '显示与输入', '返回键', '向设备发送返回键。', 'shell', 'input keyevent KEYCODE_BACK', [], { effect: '可能退出当前页面。' }),
  command('recents', '显示与输入', '最近任务', '打开系统最近任务界面。', 'shell', 'input keyevent KEYCODE_APP_SWITCH', [], { effect: '会切换设备界面。' }),
  command('tap', '显示与输入', '点击坐标', '模拟触摸屏单击。', 'shell', 'input tap {{x}} {{y}}', [number('x', 'X 坐标', '100'), number('y', 'Y 坐标', '100')], { effect: '会触发设备该位置的操作。' }),
  command('swipe', '显示与输入', '滑动手势', '从起点滑动到终点，可指定持续时间。', 'shell', 'input swipe {{x1}} {{y1}} {{x2}} {{y2}} {{duration}}', [number('x1', '起点 X', '500'), number('y1', '起点 Y', '700'), number('x2', '终点 X', '500'), number('y2', '终点 Y', '200'), number('duration', '时长 ms', '300')], { effect: '会操作当前设备页面。' }),
  command('input-text', '显示与输入', '输入英文或数字', '向当前焦点输入文字；空格用 %s 表示。', 'shell', 'input text {{text}}', [text('text', '输入内容', 'hello%sworld')], { effect: '会向设备当前输入框输入内容。', note: '原生 input text 通常不支持中文等 Unicode 输入。' }),
  command('foreground', '性能与系统', '当前前台 Activity', '查看 Activity 栈与前台页面。', 'shell', 'dumpsys activity activities'),
  command('windows', '性能与系统', '窗口与焦点', '检查窗口焦点、显示和输入目标。', 'shell', 'dumpsys window windows'),
  command('memory', '性能与系统', '应用内存', '查看指定应用 PSS、堆和内存分类。', 'shell', 'dumpsys meminfo {{package}}', [pkg]),
  command('cpu', '性能与系统', 'CPU 占用', '查看系统近期 CPU 使用情况。', 'shell', 'dumpsys cpuinfo'),
  command('top', '性能与系统', '进程资源快照', '获取一次进程 CPU、内存快照。', 'shell', 'top -b -n 1', [], { note: '不同 Android 固件的 top 参数可能有差异。' }),
  command('frames', '性能与系统', '应用帧渲染统计', '查看应用绘制耗时和掉帧线索。', 'shell', 'dumpsys gfxinfo {{package}}', [pkg]),
  command('services', '性能与系统', '可诊断系统服务', '列出 dumpsys 支持的服务。', 'shell', 'dumpsys -l'),
  command('settings', '性能与系统', '打开系统设置', '进入设备系统设置。', 'shell', 'am start -a android.settings.SETTINGS', [], { effect: '会切换设备前台页面。' }),
  command('developer-settings', '性能与系统', '打开开发者选项', '进入设备开发者设置页面。', 'shell', 'am start -a android.settings.APPLICATION_DEVELOPMENT_SETTINGS', [], { effect: '会切换设备前台页面。', note: '入口是否可用取决于固件。' }),
  command('wifi-settings', '性能与系统', '打开 Wi-Fi 设置', '进入设备 Wi-Fi 设置页面。', 'shell', 'am start -a android.settings.WIFI_SETTINGS', [], { effect: '会切换设备前台页面。' }),
  command('grant', '性能与系统', '授予运行时权限', '授予应用已声明且允许通过 pm grant 授予的权限。', 'shell', 'pm grant {{package}} {{permission}}', [pkg, { ...pkg, key: 'permission', label: '权限名称', placeholder: 'android.permission.CAMERA' }], { effect: '会修改应用权限。', note: '不适用于签名权限、特权权限或特殊访问授权。' }),
  command('revoke', '性能与系统', '撤销运行时权限', '撤销应用的指定运行时权限。', 'shell', 'pm revoke {{package}} {{permission}}', [pkg, { ...pkg, key: 'permission', label: '权限名称', placeholder: 'android.permission.CAMERA' }], { effect: '会修改应用权限，可能导致应用进程退出。' }),
  command('reboot', '性能与系统', '重启设备', '正常重启 Android 设备。', 'adb', 'reboot', [], { effect: '会中断所有设备任务和当前连接。' }),
  command('root', '性能与系统', '切换 adbd Root', '请求 adbd 以 root 身份重启，之后用 id 验证。', 'adb', 'root', [], { effect: '会重启 adbd，可能短暂断开连接。', note: '需要设备固件支持；不自动尝试 su 回退。' }),
  command('unroot', '性能与系统', '恢复 adbd 普通权限', '请求 adbd 以普通 shell 身份重启。', 'adb', 'unroot', [], { effect: '会重启 adbd 并短暂断开连接。' }),
  command('remount', '性能与系统', '重新挂载系统分区', '请求将支持的系统分区重挂载为可写。', 'adb', 'remount', [], { effect: '会改变系统分区挂载状态。', note: '通常需要 root、可调试固件和相应的启动验证配置。' })
]

export const QUICK_SHORTCUT_IDS = ['shell', 'getprop', 'packages', 'logcat', 'ip', 'resolution']

export function shortcutDefaults(shortcut: TerminalShortcut, packageName: string | null): Record<string, string> {
  return Object.fromEntries(shortcut.parameters.map((parameter) => [parameter.key,
    parameter.key === 'package' ? packageName ?? '' : parameter.defaultValue ?? '']))
}

export function buildShortcut(shortcut: TerminalShortcut, values: Record<string, string>, mode: 'adb' | 'shell' = 'adb'): string {
  if (mode === 'shell' && shortcut.scope !== 'shell') throw new Error('该命令需要退出设备 Shell 后执行。')
  const replacements = new Map<string, string>()
  for (const parameter of shortcut.parameters) {
    const value = values[parameter.key]?.trim() ?? ''
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`请填写${parameter.label}，且不能包含换行或控制字符。`)
    if (parameter.kind === 'package' && !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(value)) throw new Error(`${parameter.label}格式不正确。`)
    if (parameter.kind === 'component' && !/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(value)) throw new Error('请输入包名/Activity 组件。')
    if (parameter.kind === 'number' || parameter.kind === 'port') {
      const maximum = parameter.kind === 'port' ? 65535 : parameter.key === 'seconds' ? 180 : 1000000
      const minimum = parameter.kind === 'port' || ['pid', 'width', 'height', 'seconds', 'duration'].includes(parameter.key) ? 1 : 0
      if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${parameter.label}应为 ${minimum}–${maximum} 的整数。`)
    }
    if (parameter.kind === 'remotePath' && !value.startsWith('/')) throw new Error('设备路径必须以 / 开头。')
    if (parameter.kind === 'localPath' && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) throw new Error('请填写本机绝对路径。')
    // Shell 参数按设备端规则引用；本机 ADB 参数按 shell-quote 的解析规则引用。
    const quoted = /^[A-Za-z0-9_./:@%+-]+$/.test(value) && !value.startsWith('-')
      ? value
      : shortcut.scope === 'shell' ? `'${value.replace(/'/g, `'"'"'`)}'` : `"${value.replace(/[\\"$]/g, '\\$&')}"`
    replacements.set(parameter.key, quoted)
  }
  const body = shortcut.template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const replacement = replacements.get(key)
    if (replacement === undefined) throw new Error(`缺少参数：${key}`)
    return replacement
  })
  const result = mode === 'shell' ? body : `adb ${shortcut.scope === 'shell' ? 'shell ' : ''}${body}`
  if (result.length > 8192) throw new Error('生成的命令超过 8192 字符，请缩短参数。')
  return result
}
