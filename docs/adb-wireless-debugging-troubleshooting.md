# ADB 无线调试连接排查

本文介绍 TCP/IP 端口已经可达，但 `adb connect` 仍报告 `No route to host` 时的排查和恢复方法。

下文的 `192.0.2.10` 仅用于文档示例，执行命令时请替换为实际设备 IP。

## 典型现象

```text
adb connect 192.0.2.10:5555
failed to connect to '192.0.2.10:5555': No route to host
```

随后使用 TCP 端口探测可以成功：

```bash
nc -vz 192.0.2.10 5555
# Connection ... succeeded!
```

这时可以确认当前电脑能够访问目标 IP 的 `5555` 端口。`nc` 成功只证明 TCP 连接建立，不能单独证明端口提供的是 ADB 服务；但它说明问题不应继续只按“无线调试未开启”处理。

## 恢复步骤

重启当前命令行使用的 ADB Server 后重新连接：

```bash
adb kill-server
adb start-server
adb connect 192.0.2.10:5555
adb devices -l
```

重启可能清理 ADB Server 的临时网络连接状态、旧的设备连接状态或异常缓存。执行后应重新检查设备列表，以实际连接结果判断是否恢复。

## 判断边界

- `No route to host`：优先检查 IP、路由、ARP、VPN、VLAN 和 Wi-Fi 客户端隔离；如果端口探测已经成功，也要尝试重启 ADB Server。
- `Connection refused`：网络可达，但目标端口没有可用监听服务。
- `unauthorized`：网络连接已建立，需要在设备端确认 ADB 授权。
- `offline`：ADB 连接状态异常，先执行 `adb disconnect <IP>:<端口>`，再重新连接。
- `protocol fault` 或连接被重置：端口虽然有服务监听，但不一定是正常的 ADB 服务。

## Android 11 及以上

系统“无线调试”通常使用配对端口和动态调试端口，不应默认假设连接端口一定是 `5555`。应以设备“开发者选项 → 无线调试”页面当前显示的端口为准：

```bash
adb pair <设备 IP>:<配对端口>
adb connect <设备 IP>:<调试端口>
```

`5555` 适用于设备确实在该端口监听 ADB 的 TCP/IP 配置，例如通过 USB 执行 `adb tcpip 5555` 后的连接场景。

## 工具内置 ADB Server 的注意事项

应用默认使用独立的本机 ADB Server 端口 `5038`，必要时自动回退到 `5039–5048`。上面的命令适用于直接在终端中使用默认 ADB Server 的场景；不要把终端中的 `adb kill-server` 误认为一定会重启应用当前使用的独立 Server。应用内连接失败时，应先查看操作记录中的实际 ADB 输出和 Server 端口，再决定是否需要重启应用或处理对应的 Server 实例。
