# 0.1.0 版本说明

首版提供面向 Windows x64 的 Android ADB 图形化安装与管理工具。
当前版本和后续变更见 [版本变更](../../CHANGELOG.md)。

## 主要功能

- USB 与 TCP/IP 设备连接、APK 信息解析及安装结果回读。
- 应用启动、停止、重启、卸载和默认 Launcher 管理。
- 系统设置入口、Root 与 Remount 检查、系统应用部署及托管回滚。
- 独立 ADB Server、设备操作串行化、操作记录和诊断输出。
- Windows x64 NSIS 安装包及内置 Android Platform-Tools。

## 使用边界

- 未配置 Windows 代码签名和自动更新。
- 未内置 OEM USB 驱动；实际设备连接依赖匹配的驱动和 ADB 授权。
- Windows 安装运行、USB 连接及系统应用操作需要在目标硬件上验收。
- 构建方法和验收要求见 [README](../../README.md)。
