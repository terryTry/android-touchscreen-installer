# 安卓触摸屏安装助手

面向现场安装人员的 Windows x64 ADB 图形化工具。客户端内置 Windows 版
Android Platform-Tools，通过固定按钮完成设备连接、APK 安装、应用控制和默认
Launcher 管理，并提供面向调试人员的手动 ADB 终端。

当前版本：`0.2.1-rc.1`

版本变更见 [CHANGELOG](CHANGELOG.md)。

## 当前功能

- 标题栏提供“ADB 终端”：支持手动命令、实时输出、历史命令、复制粘贴、清屏和
  持续设备 Shell。内置 8 类共 88 条快捷命令，支持搜索、参数填写、包名预填和
  预览后填入。终端使用应用的实际 Server 端口，并绑定当前选择的设备；运行
  期间暂停其他设备操作，结束后刷新状态。使用边界见 [ADB 终端说明](docs/adb-terminal.md)。

- 自动检测 USB ADB 设备，识别已连接、未授权、离线和无权限状态；可通过菜单
  “设备管理 → 刷新 USB 设备”手动刷新。
- 支持 TCP/IP 连接，默认端口 `5555`，端口可修改。
- 多设备时要求明确选择目标序列号；所有命令由主进程自动注入 `-s <serial>`。
- 支持通过设备应用列表、当前前台、当前桌面或完整包名指定已安装应用，并按设备
  记忆；无需上传 APK 即可执行适用的启动、停止、重启、数据和 Launcher 操作。
- 选择或拖入 APK 后解析应用名、图标、包名、版本、SDK、ABI、启动组件和
  HOME Activity；设备已安装同包名应用时可直接操作现有版本。
- 安装前检查 Android API、CPU ABI 和已安装版本；支持更新、同版本覆盖和
  可选的调试 APK 降级安装。
- 签名冲突时提供经过数据丢失确认的“卸载旧版并重装”恢复流程，并按实际安装
  状态禁用不可执行的应用与 Launcher 操作。
- 安装后重新查询设备中的 `versionCode`，避免只依据 ADB 的 `Success` 判断。
- 提供返回、Home、最近任务、启动、停止、重启、卸载和清除数据。卸载会区分普通
  应用、updated system app 与直接预装 system app；系统应用必须经过额外风险确认、
  Root/Remount、Package Manager 路径复核、精确目录删除、重启和包记录验收。
- 支持设置开机应用、验证和重启后验证；需要切换回其他桌面时，在设备系统设置中选择。
- 提供设备重启、系统设置和开发者选项；标题栏常驻“操作记录”入口，跨重启保留
  最近 100 次操作。每条记录可查看结果、建议和按需加载的 ADB 诊断步骤，并可分别
  复制面向协作的操作摘要或面向技术支持的诊断详情。
- 提供经过回读验证的 Root 通道：优先尝试 `adb root`，若 adbd 仍为 shell 且
  设备预置可用 `su`，则使用 `su 0` 执行受控命令。
- 厂商 Remount 命令未使 `/system` 可写时，可在同一已验证 Root 通道内回退到
  `mount -o remount,rw /system`；两条路径都以最终可写状态回读为准。
- 系统应用部署默认使用已在目标类设备上验证过的 `/system/app` 路径，并提供
  `/system/priv-app` 特权模式、最小化 `privapp-permissions` 白名单和托管回滚。
- 客户端首选独立 ADB Server 端口 `5038`：健康的现有 ADB Server 可直接复用；
  非 ADB 服务占用时自动选择 `5039–5048` 中的可用端口。退出时只停止自己启动的
  Server，并在终端中断或系统结束进程时执行尽力清理。

完整范围和验收标准见 [V0.1 PRD](docs/PRD-v0.1.md)。

无线调试连接的网络边界、`No route to host` 排查和 ADB Server 重启恢复步骤见
[ADB 无线调试连接排查](docs/adb-wireless-debugging-troubleshooting.md)。

## 架构

```plantuml
@startuml
skinparam componentStyle rectangle

actor "现场人员" as User
component "React 渲染进程\n只负责界面" as Renderer
component "受限 Preload API\n白名单 IPC" as Preload
component "Electron 主进程" as Main
component "命令注册表与工作流" as Workflow
component "APK 解析器" as Parser
component "独立 ADB Server\n首选 5038 / 自动备用" as Adb
device "安卓触摸屏" as Device

User --> Renderer
Renderer --> Preload
Preload --> Main
Main --> Workflow
Main --> Parser
Workflow --> Adb
Adb --> Device : USB / TCP:5555（可修改）
@enduml
```

ADB、文件系统、进程调用和持久化只存在于 Electron 主进程。渲染进程启用
`contextIsolation` 和沙箱，不启用 Node.js。按钮提交固定命令 ID；终端提交命令文本，
由主进程解析和校验，固定使用应用 ADB、Server 和设备，不启动本机 Shell。

特权应用部署保留 APK 权限声明、设备权限定义及授权状态的内部校验，用于生成
最小化白名单和部署后验收。界面不再提供权限检测面板或自动权限准备工作流；
运行时权限与特殊访问由用户在设备端授权。系统部署前仍会阻止降级覆盖活动更新包
以及创建同包名的重复系统副本。

## macOS ARM64 开发

正式产物只面向 Windows x64，但可以在 Apple Silicon Mac 上开发和调试界面及
绝大多数 ADB 工作流。

环境要求：

- Node.js `20.19+` 或 `22.12+`，建议使用 Node.js 22 LTS。
- npm。
- 本机 Android SDK Platform-Tools，默认会依次查找
  `ANDROID_SDK_ROOT`、`ANDROID_HOME`、`~/Library/Android/sdk/platform-tools/adb`
  和 Homebrew 常见路径。

```bash
npm install
npm run dev
```

如需明确指定 macOS ADB：

```bash
ADB_PATH=/绝对路径/platform-tools/adb npm run dev
```

开发环境使用本机 ADB；Windows 驱动、UAC、NSIS、SmartScreen 和内置
`adb.exe` 必须在真实 Windows 10/11 x64 电脑上验收。

## 检查与构建

```bash
# 类型检查、单元测试和 Electron 资源构建
npm run build

# 从 macOS ARM64 交叉生成 Windows x64 NSIS 安装包
npm run build:win
```

构建产物位于 `release/`。项目不配置 Windows 代码签名，因此安装时可能出现
SmartScreen 提示；正式交付前必须在 Windows Defender 开启的环境中验证。

## ADB 与 USB 驱动的边界

`adb.exe` 不是 Windows USB 驱动。V0.1 已内置官方 Windows Platform-Tools，
但不能为未知硬件提供“万能驱动”。

是否必须知道触摸屏的商品型号取决于厂商资料是否完整。驱动匹配真正需要的是：

1. Windows 设备管理器中的 USB 硬件 ID，即 `VID/PID/MI`。
2. 厂商提供且适配 Windows x64 的已签名 `INF + CAT` 驱动包。
3. 驱动版本、厂商名称和允许随客户端重新分发的授权。

如果厂商能直接提供以上内容，商品型号只用于追踪和验收；如果没有驱动包，则需要
通过触摸屏厂商与型号向厂商索取。未取得资料前，程序会将 `adb devices -l` 返回的
实际 USB ADB 识别状态与“安装包是否内置 OEM 驱动包”分开显示；未内置驱动包不代表
当前 USB 连接异常。程序不修改 INF，也不强制把通用 WinUSB 绑定到未知接口。

驱动资料取得后，按 [驱动目录说明](resources/drivers/README.md) 集成，并在真实
Windows 电脑上验证硬件 ID、数字签名和 UAC。只有满足这些条件，后续才能安全加入
基于 `pnputil` 的一次性提权安装。

## Windows 验收清单

- 在未安装 Android Studio、未配置系统 ADB 的 Windows 10/11 x64 电脑安装。
- 确认安装目录中包含 `adb.exe`、`AdbWinApi.dll` 和 `AdbWinUsbApi.dll`。
- 验证 USB 插拔、首次 RSA 授权、离线恢复以及多设备选择。
- 验证 TCP/IP 默认端口 `5555` 和自定义端口。
- 使用真实业务 APK 验证 Manifest、图标、ABI 和 HOME Activity 解析。
- 验证安装、覆盖、允许的降级、实际版本回读以及安装失败提示。
- 记录原 Launcher，依次验证设置、重启后验证和恢复。
- 验证 NSIS 安装/卸载、Windows Defender 和 SmartScreen 行为。
- 若集成 OEM 驱动，额外验证 VID/PID/MI、数字签名、UAC 和重新插拔后的识别。

## 明确不包含

当前版本不包含 Device Owner/kiosk、系统栏控制、唤醒/电源键、截图和文件管理专用界面、
Logcat 专用查看器、本机 CMD/PowerShell 终端、自定义命令 JSON、自动更新和非 Windows
x64 正式安装包。文件传输和日志读取可使用手动 ADB 终端。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。第三方组件及其许可见
[第三方软件说明](THIRD_PARTY_NOTICES.md)，相关版权和许可声明随源码及安装包保留。

## GitHub 自动 Release

工作流 `.github/workflows/release.yml` 在推送版本 tag 时运行：

| tag | 发布类型 |
| --- | --- |
| `v0.2.2` | 正式 Release |
| `v0.3.0-rc.1` | Prerelease，不标记为 Latest |

只接受 `vX.Y.Z`、`vX.Y.Z-rc.N`；其他匹配触发通配符的 tag 会在校验阶段失败，不构建或发布。
推送前必须将 `package.json`、`package-lock.json` 的版本更新为 tag 去掉 `v` 后的值，
并把工作流及版本变更提交到 tag 指向的提交中。普通分支推送不触发此流程。

流程使用 Windows runner 和 Node.js 24.16.0，执行 `npm ci`、类型检查、测试与 Windows x64 NSIS 构建。
由 GitHub CLI 发布，electron-builder 禁用自动发布。上传安装包、blockmap 和 `SHA256SUMS.txt` 后，
核对 GitHub 返回的制品 SHA-256，全部一致才将草稿公开。RC 自动标记为预发布。
构建通过不代表 Windows 真机安装和设备功能验收通过；当前安装包未签名。

工作流使用仓库自动提供的 `GITHUB_TOKEN`（`contents: write`），无需配置个人访问令牌。
上传或校验失败会保留草稿，可在 Actions 中重新运行；已经公开的同名 Release 不覆盖，需使用新版本 tag。
本流程不会自动创建或推送 tag。
