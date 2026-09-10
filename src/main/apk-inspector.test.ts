import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ApkInspector,
  extractDeclaredPermissions,
  extractDefinedPermissions
} from './apk-inspector'

describe('APK 解析', () => {
  let fixtureDirectory = ''
  let fixturePath = ''

  beforeAll(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'adb-tool-apk-'))
    fixturePath = join(fixtureDirectory, 'home-launcher.apk')
    const base64 = await readFile(
      join(process.cwd(), 'test-fixtures', 'home-launcher', 'home-launcher.apk.b64'),
      'utf8'
    )
    await writeFile(fixturePath, Buffer.from(base64.trim(), 'base64'))
  })

  afterAll(async () => {
    await rm(fixtureDirectory, { recursive: true, force: true })
  })

  it('从最终 Manifest 识别包信息和 HOME Activity', async () => {
    const result = await new ApkInspector().inspect(fixturePath)

    expect(result.info).toMatchObject({
      appName: '示例触摸屏应用',
      applicationClassName: 'android.app.Application',
      packageName: 'com.example.touchscreen',
      versionName: '1.3.2',
      versionCode: 10302,
      minSdk: 26,
      targetSdk: 35,
      debuggable: true,
      selectedHomeComponent:
        'com.example.touchscreen/com.example.touchscreen.MainActivity'
    })
    expect(result.info.homeActivities).toEqual([
      {
        name: 'com.example.touchscreen.MainActivity',
        component: 'com.example.touchscreen/com.example.touchscreen.MainActivity',
        exported: true
      }
    ])
    expect(result.info.launchActivity?.component).toBe(
      'com.example.touchscreen/com.example.touchscreen.MainActivity'
    )
  })

  it('拒绝伪装成 APK 的普通文件', async () => {
    const invalidPath = join(fixtureDirectory, 'invalid.apk')
    await writeFile(invalidPath, 'not a zip')
    await expect(new ApkInspector().inspect(invalidPath)).rejects.toThrow('内容不是有效')
  })

  it('提取、去重并合并 Manifest uses-permission', () => {
    expect(
      extractDeclaredPermissions([
        { name: 'android.permission.INTERNET' },
        { name: 'android.permission.CAMERA', maxSdkVersion: '28' },
        { name: 'android.permission.CAMERA', maxSdkVersion: 30 },
        { name: 'android.permission.INTERNET', maxSdkVersion: 22 }
      ])
    ).toEqual([
      { name: 'android.permission.INTERNET', maxSdkVersion: null },
      { name: 'android.permission.CAMERA', maxSdkVersion: 30 }
    ])
  })

  it('识别 APK 自己定义的签名权限', () => {
    expect(
      extractDefinedPermissions([
        {
          name: 'com.example.touchscreen.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
          protectionLevel: 'signature'
        }
      ])
    ).toEqual([
      {
        name: 'com.example.touchscreen.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
        protectionLevel: ['signature']
      }
    ])
  })
})
