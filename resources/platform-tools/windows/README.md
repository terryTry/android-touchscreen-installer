# Windows Platform-Tools

构建 Windows 安装包前，本目录必须包含 Google 官方 Windows x64 Platform-Tools 中的：

- `adb.exe`
- `AdbWinApi.dll`
- `AdbWinUsbApi.dll`
- `NOTICE.txt`
- `source.properties`

项目不使用系统 PATH 中的 ADB，也不会修改 PATH。

当前资源来自 Google 官方
`https://dl.google.com/android/repository/platform-tools-latest-windows.zip`，
版本由 `source.properties` 记录为 `37.0.0`。

为避免资源被静默替换，当前文件的 SHA-256 为：

| 文件 | SHA-256 |
| --- | --- |
| `adb.exe` | `957e46b8615f7af5b7292a2ddabe98d2e61940c3fb2b0545756507f080613e71` |
| `AdbWinApi.dll` | `120bef587119c6cb926b86b9be90fdfbce38937588eae28cd91a94ce63c7b965` |
| `AdbWinUsbApi.dll` | `6ca69a2ca0e31309c087d288f058977d421ad03500e4c3e1dbd981241a069c60` |
| `NOTICE.txt` | `628f43e9c88e2bf5aee9fc4c1cb672bf3931ba12dd5ef75c8170678395f3ca23` |
| `source.properties` | `fbd87c8567afbc6dc78e140097fcde234f4a61fa7065e85081d43e442ccd3d24` |
