export interface FriendlyError {
  summary: string
  suggestion: string
}

const ERROR_MAPPINGS: Array<{ pattern: RegExp; error: FriendlyError }> = [
  {
    pattern: /INSTALL_FAILED_VERSION_DOWNGRADE/i,
    error: {
      summary: '当前设备中的应用版本更高，普通覆盖安装不允许降级。',
      suggestion: '如 APK 为可调试版本，可在高级操作中允许降级；否则只能卸载后重装，应用数据会被清除。'
    }
  },
  {
    pattern: /INSTALL_FAILED_UPDATE_INCOMPATIBLE/i,
    error: {
      summary: '新旧应用签名不一致，无法覆盖安装。',
      suggestion: '确认 APK 来源；如必须更换签名，只能先卸载旧应用，应用数据会被清除。'
    }
  },
  {
    pattern: /INSTALL_FAILED_INSUFFICIENT_STORAGE/i,
    error: {
      summary: '设备存储空间不足，无法安装应用。',
      suggestion: '在触摸屏上释放存储空间后重试。'
    }
  },
  {
    pattern: /INSTALL_FAILED_OLDER_SDK/i,
    error: {
      summary: '设备 Android 版本低于 APK 的最低要求。',
      suggestion: '更换兼容该设备 Android 版本的 APK。'
    }
  },
  {
    pattern: /INSTALL_FAILED_NO_MATCHING_ABIS/i,
    error: {
      summary: 'APK 与设备 CPU 架构不兼容。',
      suggestion: '提供包含设备 ABI 的 APK，或使用不包含原生库的通用 APK。'
    }
  },
  {
    pattern: /INSTALL_PARSE_FAILED_/i,
    error: {
      summary: 'APK 文件无效或 Manifest 无法解析。',
      suggestion: '重新导出完整 APK，并确认文件在传输过程中没有损坏。'
    }
  },
  {
    pattern: /not a right of root|reject push|segmentation fault|signal 11|sigsegv/i,
    error: {
      summary: '设备端 adbd 拒绝文件传输。',
      suggestion: '普通 APK 可改用非 Root 的 shell 流式传输；系统分区文件仍需先在高风险确认后执行“获取 Root 权限”，并通过验证后再重试。'
    }
  },
  {
    pattern: /device offline|failed to read copy response/i,
    error: {
      summary: '设备连接已中断。',
      suggestion: '先断开旧 TCP/IP 端点，再重新连接；如果是 USB，请重新插拔或确认设备仍在线。'
    }
  },
  {
    pattern: /protocol fault|connection reset|reset by peer/i,
    error: {
      summary: 'TCP/IP 端口服务异常，未确认是 ADB。',
      suggestion: '请以设备无线调试页面显示的实际调试端口为准；检查该端口是否被其他服务占用。'
    }
  },
  {
    pattern: /failed to connect|no route to host|connection refused|unable to connect/i,
    error: {
      summary: 'TCP/IP 连接失败。',
      suggestion: '先执行只读端口探测：若端口可达，可重启应用内 ADB Server 后重试；否则检查设备网络 ADB、IP、路由和实际调试端口。'
    }
  },
  {
    pattern: /unauthorized/i,
    error: {
      summary: '设备尚未授权当前电脑。',
      suggestion: '请在触摸屏上勾选“始终允许使用这台计算机进行调试”，然后点击“允许”。'
    }
  },
  {
    pattern: /no devices\/emulators found|device .* not found/i,
    error: {
      summary: '未检测到可用设备。',
      suggestion: '检查 USB 线、USB 调试和驱动，或重新建立 TCP/IP 连接。'
    }
  },
  {
    pattern: /more than one device\/emulator/i,
    error: {
      summary: '检测到多个设备，但没有锁定目标设备。',
      suggestion: '请在界面中明确选择要操作的触摸屏。'
    }
  },
  {
    pattern: /not found|unknown command|unable to resolve intent/i,
    error: {
      summary: '当前设备或厂商系统不支持此操作。',
      suggestion: '可复制执行结果并交给开发或技术支持人员确认设备能力。'
    }
  }
]

export function mapAdbError(output: string, fallback: string): FriendlyError {
  const match = ERROR_MAPPINGS.find(({ pattern }) => pattern.test(output))
  return (
    match?.error ?? {
      summary: fallback,
      suggestion: '请复制执行结果并交给开发或技术支持人员进一步排查。'
    }
  )
}
