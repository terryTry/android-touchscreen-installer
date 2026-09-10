# ADB 终端

标题栏点击“ADB 终端”打开底部面板。先在主界面选择设备，再输入命令。

## 快捷输入

终端上方常驻 Shell、系统属性、应用列表、实时日志、IP 和分辨率 6 个常用入口。
点击“快捷命令”或在终端内按 Ctrl+K / ⌘K 打开命令库，按 Escape 关闭。

命令库提供 88 条模板，分为连接诊断、设备信息、应用管理、日志排障、网络调试、
文件传输、显示与输入、性能与系统 8 类。支持搜索中文用途或英文命令、多关键词
匹配、分类筛选和本次窗口最近填入的 12 条快捷命令。

- 无参数的常用命令直接填入输入框；其他命令先查看用途、操作影响和命令预览。
- 需要包名的模板自动带入主界面当前应用；没有选定应用时必须手动填写，不提供
  虚构包名作为默认值。端口、坐标、路径等参数会在生成前校验并正确引用。
- “填入命令”替换输入框内容，不自动执行；已有草稿可用“撤销填入”恢复。输入框
  仍可自由编辑，检查后按 Enter 执行。安装、清数据、卸载、授权等模板显示操作影响。
- 持续 Shell 中，设备端模板可以“填入 Shell”，只追加到当前输入位置，不发送
  回车。请确认设备当前处于合适的命令提示符；本机文件传输、安装等 ADB 客户端
  模板需要先 `exit` 返回命令模式。普通命令执行中仍可浏览命令库，但不能填入。
- 搜索框 ↑↓ 选择结果，Enter 填入无参数命令；有参数时转到选中结果，Tab 进入
  参数表单。命令库内支持 Tab 循环切换，关闭后焦点返回终端。

模板基于 Android 官方 [ADB](https://developer.android.com/tools/adb)、
[Logcat](https://developer.android.com/tools/logcat) 和 [dumpsys](https://developer.android.com/tools/dumpsys)
工具；具体命令、服务、权限和参数支持仍以设备固件为准。连接和 Server 管理继续
使用应用原入口，命令库不提供改变应用 Server 归属的模板。

## 命令模式

支持完整 `adb ...` 或省略 `adb` 前缀。Enter 执行，↑↓ 浏览本次窗口最近 100 条命令，
Ctrl+L 清屏。输出实时滚动，滚动区保留最近 3000 行；“复制”复制选中内容，无选中时
复制当前保留的输出。命令和终端输出只在本次窗口内保留，不写入跨重启的操作记录。

```text
adb devices -l
adb shell getprop ro.product.model
adb shell "pm list packages"
adb shell pm list packages | grep com.example
adb logcat *:E
adb install -r "C:\APK\触摸屏.apk"
adb push "C:\APK\config.json" /sdcard/config.json
adb pull /sdcard/config.json "C:\APK\config.json"
```

Windows 本机路径需要引号包裹。文件路径由 ADB 读取，路径相对于应用进程的工作目录；
建议使用绝对路径。输入不会展开本机环境变量，也不支持本机管道、重定向和命令串联。
`adb shell` 后的变量、引号和管道由设备端 Shell 解析。

支持的 ADB 子命令：`devices`、`version`、`help`、`host-features`、`server-status`、
`mdns`、`shell`、`logcat`、`install`、`install-multiple`、`install-multi-package`、
`uninstall`、`push`、`pull`、`bugreport`、`jdwp`、`get-state`、`get-serialno`、
`get-devpath`、`root`、`unroot`、`remount`、`reboot`、`usb`、`tcpip`、`forward`、
`reverse`、`features`、`disable-verity`、`enable-verity`。具体可用性由内置 ADB 和设备决定。

## 持续设备 Shell

输入 `adb shell` 进入设备交互会话。此时直接输入 `cd /sdcard`、`ls` 等设备命令，
目录、变量、设备 Shell 历史在会话期间保留。Tab 补全能力取决于设备 Shell。
`exit` 返回命令模式；Ctrl+C 发送设备端中断，通常保留 Shell 会话。

会话使用设备端 PTY，字符尺寸按启动时的面板设置；运行期间改变窗口大小不会更新
设备 PTY 尺寸，需要退出并重新进入 Shell。无需本机 CMD、PowerShell 或本机 PTY。
Shell 选项由面板管理，不接受 `adb shell -t` 等前置选项。

## 设备与生命周期

- 应用固定使用实际选中的独立 ADB Server 端口（可能是 5038 或备用端口），设备
  命令自动注入 `-s`；不接受用户覆盖设备或 Server 的全局参数。
- 终端命令和 Shell 会话期间锁定设备选择，暂停其他设备操作和后台状态轮询。
  结束后清除设备能力缓存，重新查询设备、应用、桌面等状态，再恢复按钮操作。
- “收起终端”保留会话和输出；“结束会话”终止本次 ADB 客户端并释放操作入口。
  普通命令执行期间，终端内 Ctrl+C 同样停止本次客户端。停止不撤销已经完成的
  设备操作，也不保证终止设备上已经脱离会话的后台进程。
- 会话没有固定的 30 秒超时；输出通过渲染确认控制读取速度，不累计完整日志。
  设备连接关闭导致 ADB 客户端退出时，会话返回命令模式；网络未及时报告断连时
  可以手动“结束会话”。关闭应用、重载页面或渲染进程崩溃时会清理客户端。
- 连接、配对、ADB Server 启停等命令由应用管理，终端不开放；连接和修复仍使用
  原界面。手动命令不会自动应用按钮工作流的 Root 回退、风险确认或结果回读步骤。

## 验证范围

自动测试覆盖参数边界、设备互斥、会话生命周期、输入输出、输出限流和面板操作。
Windows 真机仍需验证中文路径、交互 Shell、Ctrl+C、设备断连、应用退出、长时间
Logcat，以及手动修改设备后主界面状态是否正确刷新。

参考：[ADB 官方命令说明](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md)、
[xterm.js 输出流量控制](https://xtermjs.org/docs/guides/flowcontrol/)。
