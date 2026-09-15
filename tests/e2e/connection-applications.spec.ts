import { test, expect, snapshot, apkSnapshot, apk, deviceApplication } from './fixtures'

for (const [state, message] of [
  ['unauthorized', '等待设备授权'], ['offline', '设备离线'], ['no-permissions', 'USB ADB 访问受限']
] as const) {
  test(`${state} 设备显示对应状态并禁止设备命令`, async ({ app, page }) => {
    const initial = snapshot()
    await app.open(snapshot({ devices: [{ ...initial.devices[0]!, state }], selectedDevice: null }))
    await expect(page.locator('.device-status')).toContainText(message)
    await expect(page.getByRole('button', { name: '返回', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '读取应用', exact: true })).toBeDisabled()
    await app.expectCalls('executeCommand', [])
  })
}

test('无设备提示与多设备显式选择，收到断开事件后禁用操作', async ({ app, page }) => {
  await app.open(snapshot({ devices: [], selectedSerial: null, selectedDevice: null }))
  await expect(page.getByRole('combobox', { name: '当前设备' })).toBeDisabled()
  await expect(page.getByText('未检测到 USB ADB 设备', { exact: true })).toBeVisible()
  const initial = snapshot()
  const second = { ...initial.selectedDevice!, serial: 'E2E-USB-002', model: '第二台触摸屏' }
  const multiple = snapshot({ devices: [...initial.devices, second], selectedSerial: null, selectedDevice: null })
  await app.publish(multiple)
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeDisabled()
  await app.reply('selectDevice', { ...multiple, selectedSerial: second.serial, selectedDevice: second })
  await page.getByRole('combobox', { name: '当前设备' }).selectOption(second.serial)
  await app.expectCalls('selectDevice', [[second.serial]])
  await expect(page.getByRole('combobox', { name: '当前设备' })).toHaveValue(second.serial)
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeEnabled()
  await expect(page.getByText('1920 × 1080', { exact: true })).toBeVisible()
  await app.publish(snapshot({ devices: [], selectedDevice: null, selectedSerial: null }))
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeDisabled()
})

test('TCP 表单校验、自定义端口、失败修复和返回 USB', async ({ app, page }) => {
  await app.open()
  const tcp = snapshot({ connectionMode: 'tcp', devices: [], selectedSerial: null, selectedDevice: null })
  await app.reply('setConnectionMode', tcp)
  await page.getByRole('button', { name: 'TCP/IP', exact: true }).click()
  await app.expectCalls('setConnectionMode', [['tcp']])
  await expect(page.getByRole('spinbutton', { name: '端口', exact: true })).toHaveValue('5555')
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: '设备 IP' }).fill(' 192.0.2.10 ')
  await page.getByRole('spinbutton', { name: '端口', exact: true }).fill('65536')
  await page.getByRole('button', { name: '连接', exact: true }).click()
  expect(await page.getByRole('spinbutton', { name: '端口', exact: true }).evaluate((el: HTMLInputElement) => el.validity.rangeOverflow)).toBe(true)
  await app.expectCalls('connectTcp', [])
  await page.getByRole('spinbutton', { name: '端口', exact: true }).fill('37123')
  const failure = { ...tcp, tcpRepair: { ...tcp.tcpRepair, endpoint: { host: '192.0.2.10', port: 37123 }, phase: 'available' as const, message: '连接失败，可排查并修复。' } }
  await app.reply('connectTcp', failure)
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await app.expectCalls('connectTcp', [[{ host: '192.0.2.10', port: 37123 }]])
  await expect(page.getByRole('status', { name: 'TCP/IP 连接修复' })).toContainText('192.0.2.10:37123')
  await app.reply('repairTcpConnection', { ...failure, tcpRepair: { ...failure.tcpRepair, phase: 'success', probe: 'open', message: '已重新建立连接。', serverPort: 5042 } })
  await page.getByRole('button', { name: '修复 TCP/IP 连接' }).click()
  await app.expectCalls('repairTcpConnection', [[]])
  await expect(page.getByRole('status', { name: 'TCP/IP 连接修复' })).toContainText('已修复')
  await expect(page.getByRole('status', { name: 'TCP/IP 连接修复' })).toContainText('端口探测：可达')
  await app.reply('setConnectionMode', snapshot())
  await page.getByRole('button', { name: 'USB', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '设备 IP' })).toBeHidden()
})

test('设备应用搜索、空结果、Activity 匹配和无需 APK 的操作', async ({ app, page }) => {
  await app.open()
  const catalog = snapshot({ deviceApplicationCatalog: { serial: deviceApplication.serial, applications: [
    { packageName: apk.packageName, launchActivity: apk.launchActivity, homeActivities: apk.homeActivities, isCurrentHome: false },
    { packageName: 'com.android.launcher', launchActivity: null, homeActivities: [{ name: 'SystemHome', component: 'com.android.launcher/.SystemHome', exported: true }], isCurrentHome: true }
  ] } })
  await app.reply('refreshDeviceApplications', catalog)
  await page.getByRole('button', { name: '选择设备应用', exact: true }).click()
  await app.expectCalls('refreshDeviceApplications', [[]])
  const dialog = page.getByRole('dialog', { name: '选择设备应用' })
  await expect(dialog.getByText('共 2 个应用')).toBeVisible()
  await dialog.getByRole('searchbox').fill('not-found')
  await expect(dialog.getByText('没有匹配的应用')).toBeVisible()
  await dialog.getByRole('searchbox').fill('HOMEACTIVITY')
  await expect(dialog.locator('.application-picker-item')).toHaveCount(1)
  await app.reply('loadDeviceApplication', snapshot({ selectedDeviceApplication: deviceApplication }))
  await dialog.getByRole('button', { name: /com.example.panel/ }).click()
  await app.expectCalls('loadDeviceApplication', [[apk.packageName]])
  await expect(dialog).toBeHidden()
  await expect(page.getByText('从目标设备读取 · 无需上传 APK')).toBeVisible()
  for (const name of ['启动应用', '停止应用', '重启应用', '设为开机应用', '验证开机应用']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeEnabled()
  }
  await expect(page.getByRole('button', { name: '安装 / 更新' })).toHaveCount(0)
})

test('包名去空白、读取失败提示关闭、前台与桌面快捷入口', async ({ app, page }) => {
  await app.open()
  await page.getByRole('textbox', { name: '目标应用包名' }).fill(' com.example.missing ')
  await app.reject('loadDeviceApplication', '目标设备没有安装此应用。')
  await page.getByRole('button', { name: '读取应用', exact: true }).click()
  await app.expectCalls('loadDeviceApplication', [['com.example.missing']])
  await expect(page.getByRole('alert')).toHaveText('目标设备没有安装此应用。')
  await page.getByRole('button', { name: '关闭错误提示' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await app.reply('loadForegroundApplication', snapshot({ selectedDeviceApplication: deviceApplication }))
  await page.getByRole('button', { name: '使用当前前台' }).click()
  await app.expectCalls('loadForegroundApplication', [[]])
  await expect(page.getByRole('textbox', { name: '目标应用包名' })).toHaveValue(apk.packageName)
  await page.getByRole('button', { name: '使用当前桌面' }).click()
  await app.expectCalls('loadDeviceApplication', [['com.example.missing'], ['com.android.launcher']])
})

test('选择 APK 展示解析信息；拖入无效文件被拦截，有效文件交给 Preload', async ({ app, page }) => {
  await app.open()
  await app.reply('chooseApk', apkSnapshot())
  await page.getByRole('button', { name: '浏览文件' }).click()
  await app.expectCalls('chooseApk', [[]])
  await expect(page.locator('.apk-summary')).toContainText('panel.apk · 5.0 MB')
  await expect(page.locator('.apk-summary')).toContainText('2.0.0（200）')
  for (const name of ['notes.txt', 'PANEL.APK']) {
    const transfer = await page.evaluateHandle((name) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['fixture'], name, { type: 'application/octet-stream' }))
      return transfer
    }, name)
    await app.reply('parseDroppedApk', apkSnapshot())
    await page.locator('.drop-zone').dispatchEvent('drop', { dataTransfer: transfer })
    await transfer.dispose()
    if (name === 'notes.txt') {
      await expect(page.getByRole('alert')).toHaveText('只支持拖入 .apk 文件。')
      await app.expectCalls('parseDroppedApk', [])
    }
  }
  await app.expectCalls('parseDroppedApk', [[{ name: 'PANEL.APK', size: 7, type: 'application/octet-stream' }]])
  await expect(page.getByRole('alert')).toHaveCount(0)
})
