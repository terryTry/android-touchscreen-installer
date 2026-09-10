import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

interface ResolveAdbOptions {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  platform: NodeJS.Platform
  environment: NodeJS.ProcessEnv
}

export function resolveAdbPath(options: ResolveAdbOptions): string {
  if (options.isPackaged) {
    return join(options.resourcesPath, 'platform-tools', 'windows', 'adb.exe')
  }

  const configured = options.environment.ADB_PATH
  if (configured && isAbsolute(configured)) {
    return configured
  }

  if (options.platform === 'win32') {
    return join(options.appPath, 'resources', 'platform-tools', 'windows', 'adb.exe')
  }

  const candidates = [
    options.environment.ANDROID_SDK_ROOT
      ? join(options.environment.ANDROID_SDK_ROOT, 'platform-tools', 'adb')
      : null,
    options.environment.ANDROID_HOME
      ? join(options.environment.ANDROID_HOME, 'platform-tools', 'adb')
      : null,
    join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    '/usr/bin/adb'
  ].filter((candidate): candidate is string => candidate !== null)

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

export function resolveDriverDirectory(resourcesPath: string, appPath: string, isPackaged: boolean): string {
  return isPackaged ? join(resourcesPath, 'drivers') : join(appPath, 'resources', 'drivers')
}
