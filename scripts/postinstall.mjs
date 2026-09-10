import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

function runNodeScript(scriptPath, args = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

// Electron 43 的 npm 包提供显式安装器；先获取当前平台二进制，再校验原生依赖。
runNodeScript(join(process.cwd(), 'node_modules', 'electron', 'install.js'))
runNodeScript(join(process.cwd(), 'node_modules', 'electron-builder', 'cli.js'), [
  'install-app-deps'
])
