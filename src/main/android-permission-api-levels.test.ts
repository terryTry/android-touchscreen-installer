import { describe, expect, it } from 'vitest'
import {
  ANDROID_PERMISSION_API_METADATA_COUNT,
  ANDROID_PERMISSION_API_METADATA_LEVEL,
  platformPermissionApiRange
} from './android-permission-api-levels'

describe('Android 平台权限 API 元数据', () => {
  it('记录常用权限的官方引入版本', () => {
    expect(ANDROID_PERMISSION_API_METADATA_LEVEL).toBe(36)
    expect(ANDROID_PERMISSION_API_METADATA_COUNT).toBe(372)
    expect(platformPermissionApiRange('android.permission.INTERNET')).toEqual({
      introducedApiLevel: 1,
      removedApiLevel: null
    })
    expect(platformPermissionApiRange('android.permission.BLUETOOTH_SCAN')).toEqual({
      introducedApiLevel: 31,
      removedApiLevel: null
    })
    expect(
      platformPermissionApiRange('android.permission.NEARBY_WIFI_DEVICES')
    ).toEqual({
      introducedApiLevel: 33,
      removedApiLevel: null
    })
  })

  it('记录已从公开平台 API 移除的权限，并忽略厂商自定义权限', () => {
    expect(
      platformPermissionApiRange('android.permission.READ_HISTORY_BOOKMARKS')
    ).toEqual({
      introducedApiLevel: 4,
      removedApiLevel: 23
    })
    expect(platformPermissionApiRange('com.vendor.permission.CONTROL')).toBeNull()
    expect(platformPermissionApiRange('android.permission.VENDOR_CONTROL')).toBeNull()
  })
})
