import { test, expect, snapshot, apkSnapshot, apk, deviceApplication, historyDetail } from './fixtures'

for (const [name, commandId] of [
  ['返回', 'nav.back'], ['Home', 'nav.home'], ['最近任务', 'nav.recents'],
  ['启动应用', 'app.launch'], ['验证开机应用', 'launcher.verify'],
  ['系统设置', 'system.settings'], ['开发者选项', 'system.developerSettings']
] as const) {
  test(`${name} 直接提交正确的安全命令`, async ({ app, page }) => {
    await app.open(snapshot({ selectedDeviceApplication: deviceApplication }))
    await page.getByRole('button', { name, exact: true }).click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await app.expectCalls('executeCommand', [[{ commandId }]])
  })
}

for (const [name, commandId] of [
  ['停止应用', 'app.stop'], ['重启应用', 'app.restart'], ['设为开机应用', 'launcher.set'],
  ['重启并验证', 'launcher.rebootVerify'], ['重启设备', 'device.reboot'],
  ['清除应用数据', 'app.clearData']
] as const) {
  test(`${name} 取消不提交，确认后只提交一次`, async ({ app, page }) => {
    await app.open(snapshot({ selectedDeviceApplication: deviceApplication }))
    if (commandId === 'app.clearData') await app.advanced()
    await page.getByRole('button', { name, exact: true }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await app.expectCalls('executeCommand', [])
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()
    await app.expectCalls('executeCommand', [])
    await page.getByRole('button', { name, exact: true }).click()
    await dialog.getByRole('button', { name: '确认执行' }).click()
    await app.expectCalls('executeCommand', [[{ commandId }]])
    await expect(dialog).toBeHidden()
  })
}

test('安装确认、运行进度、忙碌互斥与成功结果', async ({ app, page }) => {
  const initial = apkSnapshot()
  await app.open(initial)
  await page.getByRole('button', { name: '安装 / 更新' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('2.0.0（200）')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await app.expectCalls('executeCommand', [])
  const running = { ...initial, busy: true, operation: { ...initial.operation, id: 'install', commandId: 'app.install' as const, status: 'running' as const, startedAt: new Date().toISOString(), stage: '传输 APK', summary: '等待设备接收完成，请保持连接。' } }
  await app.reply('executeCommand', running)
  await page.getByRole('button', { name: '安装 / 更新' }).click()
  await dialog.getByRole('button', { name: '确认执行' }).click()
  await app.expectCalls('executeCommand', [[{ commandId: 'app.install', allowDowngrade: false }]])
  await expect(page.getByRole('progressbar', { name: '传输 APK' })).not.toHaveAttribute('value')
  for (const name of ['浏览文件', 'Home', '安装 / 更新', 'TCP/IP', '启动应用']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
  }
  await expect(page.getByRole('combobox', { name: '当前设备' })).toBeDisabled()
  await app.publish({ ...running, operation: { ...running.operation, stage: '安装 APK', progress: 60 } })
  await expect(page.getByRole('progressbar', { name: '安装 APK' })).toHaveAttribute('value', '60')
  await app.publish({ ...initial, operation: { ...running.operation, status: 'success', stage: '完成', progress: 100, summary: '安装成功，版本已验证。', finishedAt: new Date().toISOString(), durationMs: 2000 } })
  await expect(page.locator('.progress-row')).toContainText('安装成功，版本已验证。')
  await expect(page.locator('.progress-row')).not.toContainText('本次操作已耗时')
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeEnabled()
})

test('兼容性失败和非调试降级不可安装，调试降级需要明确开启', async ({ app, page }) => {
  const initial = apkSnapshot()
  await app.open({ ...initial, compatibility: { ...initial.compatibility!, ok: false, errors: ['设备 API 低于 APK 最低要求。'] } })
  await expect(page.getByText('设备 API 低于 APK 最低要求。')).toBeVisible()
  await expect(page.getByRole('button', { name: '安装 / 更新' })).toBeDisabled()
  const downgrade = { ...initial, selectedApk: { ...apk, debuggable: false }, compatibility: { ...initial.compatibility!, versionRelation: 'downgrade' as const } }
  await app.publish(downgrade)
  await app.advanced()
  const checkbox = page.getByRole('checkbox', { name: /允许调试版 APK 降级安装/ })
  await expect(checkbox).toBeDisabled()
  await expect(page.getByRole('button', { name: '安装 / 更新' })).toBeDisabled()
  await app.publish({ ...downgrade, selectedApk: apk })
  await expect(checkbox).toBeEnabled()
  await expect(page.getByRole('button', { name: '安装 / 更新' })).toBeDisabled()
  await checkbox.check()
  await page.getByRole('button', { name: '降级安装' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认执行' }).click()
  await app.expectCalls('executeCommand', [[{ commandId: 'app.install', allowDowngrade: true }]])
})

test('卸载风险勾选在关闭后重置', async ({ app, page }) => {
  await app.open(apkSnapshot())
  await app.advanced()
  await page.getByRole('button', { name: '卸载应用', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('系统应用删除后只能通过重新安装或刷写固件恢复')
  await expect(dialog.getByRole('button', { name: '确认执行' })).toBeDisabled()
  await dialog.getByRole('checkbox').check()
  await page.keyboard.press('Escape')
  await app.expectCalls('executeCommand', [])
  await page.getByRole('button', { name: '卸载应用', exact: true }).click()
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: '确认执行' })).toBeDisabled()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '确认执行' }).click()
  await app.expectCalls('executeCommand', [[{ commandId: 'app.uninstall' }]])
})

test('签名冲突恢复要求数据确认，当前桌面禁止卸载重装', async ({ app, page }) => {
  const initial = apkSnapshot()
  const conflict = { ...initial, operation: { ...initial.operation, status: 'error' as const, summary: '新旧应用签名不一致。', recovery: { kind: 'signature-conflict' as const, commandId: 'app.replace' as const, serial: initial.selectedSerial!, apkToken: apk.token, packageName: apk.packageName } } }
  await app.open({ ...conflict, launcher: { ...initial.launcher, currentPackage: apk.packageName } })
  await expect(page.getByRole('button', { name: '卸载旧版并重装' })).toBeDisabled()
  await app.publish(conflict)
  await expect(page.getByRole('button', { name: '安装 / 更新' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '启动应用', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '卸载旧版并重装' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('永久删除')
  await expect(dialog.getByRole('button', { name: '确认执行' })).toBeDisabled()
  await app.expectCalls('executeCommand', [])
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '确认执行' }).click()
  await app.expectCalls('executeCommand', [[{ commandId: 'app.replace' }]])
})

for (const mode of ['system', 'privileged'] as const) {
  test(`${mode} 部署受 Root 和确认约束，提交所选模式`, async ({ app, page }) => {
    const initial = apkSnapshot()
    await app.open(initial)
    await app.advanced()
    await expect(page.getByRole('button', { name: '部署为系统应用', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '获取 Root 权限' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '确认执行' }).click()
    await app.expectCalls('executeCommand', [[{ commandId: 'device.rootAccess' }]])
    const rooted = { ...initial, selectedDevice: { ...initial.selectedDevice!, rootAccessMode: 'su' as const } }
    await app.publish(rooted)
    await expect(page.getByRole('button', { name: 'Root 权限已验证' })).toBeDisabled()
    if (mode === 'privileged') {
      await page.getByRole('radio', { name: /^特权应用/ }).check()
      await expect(page.getByRole('button', { name: '部署为特权应用' })).toBeDisabled()
      await app.publish({ ...rooted, permissionCompatibility: { state: 'ready', serial: initial.selectedSerial, deviceApiLevel: 31, permissions: [], summary: { total: 0, ready: 0, userAction: 0, adbAction: 0, unavailable: 0, notApplicable: 0, unknown: 0 }, plan: { total: 0, pmGrant: 0, appOps: 0, serviceCommand: 0, systemApp: 0, privilegedAllowlist: 0, requiresApk: false, requiresRoot: false, requiresReboot: false }, systemModification: { state: 'verified', reason: '测试状态：Root 已验证' }, inspectionError: null } })
    } else {
      await expect(page.getByRole('radio', { name: /^系统应用/ })).toBeChecked()
    }
    await page.getByRole('button', { name: mode === 'system' ? '部署为系统应用' : '部署为特权应用', exact: true }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText(mode === 'system' ? '/system/app' : '/system/priv-app')
    await expect(dialog.getByRole('button', { name: '确认执行' })).toBeDisabled()
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: '确认执行' }).click()
    await app.expectCalls('executeCommand', [[{ commandId: 'device.rootAccess' }], [{ commandId: 'app.deploySystem', systemDeploymentMode: mode }]])
  })
}

test('已有托管部署无需 APK 可确认回滚', async ({ app, page }) => {
  const initial = snapshot()
  await app.open({ ...initial, selectedDevice: { ...initial.selectedDevice!, rootAccessMode: 'adbd' }, selectedDeviceApplication: deviceApplication, systemDeployment: { serial: initial.selectedSerial!, packageName: apk.packageName, versionCode: 200, deploymentMode: 'system', appDirectory: '/system/app/AdbTool_com_example_panel', apkPath: '/system/app/AdbTool_com_example_panel/base.apk', allowlistPath: null, createdAt: '2026-09-14T01:00:00Z' } })
  await app.advanced()
  await expect(page.getByRole('button', { name: '部署为系统应用', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '回滚系统应用部署' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('button', { name: '确认执行' })).toBeDisabled()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '确认执行' }).click()
  await app.expectCalls('executeCommand', [[{ commandId: 'app.rollbackSystem' }]])
})

test('操作历史按需加载、失败筛选、诊断展开与两种复制', async ({ app, page }) => {
  const success = historyDetail('success', 'success')
  const failure = historyDetail('failure', 'error')
  const { logs: _successLogs, ...successEntry } = success
  const { logs: _failureLogs, ...failureEntry } = failure
  await app.open(snapshot({ operationHistory: [successEntry, failureEntry] }))
  await app.expectCalls('getOperationHistoryDetail', [])
  await app.reply('getOperationHistoryDetail', success)
  await page.getByRole('button', { name: '打开操作记录，共 2 条' }).click()
  const dialog = page.getByRole('dialog', { name: '操作记录', exact: true })
  await expect(dialog).toBeVisible()
  await app.expectCalls('getOperationHistoryDetail', [['success']])
  await app.reply('getOperationHistoryDetail', failure)
  await dialog.getByRole('button', { name: '失败 1', exact: true }).click()
  await expect(dialog.getByRole('navigation', { name: '历史操作列表' }).getByRole('button')).toHaveCount(1)
  await expect(dialog.getByRole('region', { name: '所选操作详情' })).toContainText('释放设备存储空间后重试。')
  await dialog.locator('summary').filter({ hasText: 'Package Manager 安装' }).click()
  await expect(dialog.getByText('INSTALL_FAILED_INSUFFICIENT_STORAGE', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '复制操作摘要' }).click()
  await app.expectCalls('copyOperationSummary', [['failure']])
  await expect(dialog.getByRole('button', { name: '摘要已复制' })).toBeVisible()
  await dialog.getByRole('button', { name: '复制诊断详情' }).click()
  await app.expectCalls('copyOperationDiagnostics', [['failure']])
  await expect(dialog.getByRole('button', { name: '详情已复制' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('')
})

test('多个 HOME Activity 需选择导出组件后才能设置 Launcher', async ({ app, page }) => {
  const secondHome = { name: 'OtherHome', component: 'com.example.panel/.OtherHome', exported: true }
  const initial = apkSnapshot({ selectedApk: { ...apk, selectedHomeComponent: null, homeActivities: [...apk.homeActivities, secondHome, { name: 'PrivateHome', component: 'com.example.panel/.PrivateHome', exported: false }] } })
  await app.open(initial)
  await expect(page.getByRole('button', { name: '设为开机应用' })).toBeDisabled()
  const select = page.locator('.apk-summary select')
  await expect(select.locator('option')).toHaveCount(3)
  await app.reply('selectHomeActivity', { ...initial, selectedApk: { ...initial.selectedApk!, selectedHomeComponent: secondHome.component } })
  await select.selectOption(secondHome.component)
  await app.expectCalls('selectHomeActivity', [[secondHome.component]])
  await expect(select).toHaveValue(secondHome.component)
  await expect(page.getByRole('button', { name: '设为开机应用' })).toBeEnabled()
})

test('空操作记录可筛选和关闭', async ({ app, page }) => {
  await app.open()
  await page.getByRole('button', { name: '打开操作记录，共 0 条' }).click()
  const dialog = page.getByRole('dialog', { name: '操作记录', exact: true })
  await expect(dialog.getByText('尚无操作记录', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '失败 0' }).click()
  await expect(dialog.getByText('没有失败记录', { exact: true })).toBeVisible()
  await app.expectCalls('getOperationHistoryDetail', [])
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('窗口宽度内保持主要入口可达并留存页面截图', async ({ app, page }, testInfo) => {
  await app.open(apkSnapshot())
  await expect(page.getByRole('button', { name: 'ADB 终端', exact: true })).toBeInViewport()
  await expect(page.getByRole('button', { name: '打开操作记录，共 0 条' })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  await app.advanced()
  await page.getByRole('button', { name: '卸载应用', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: '卸载应用', exact: true })).toBeInViewport()
  // 回到顶部再截全页，避免 sticky 标题栏遮挡截图中部内容。
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('main.png'), fullPage: true })
  await testInfo.attach('应用主界面', { path: testInfo.outputPath('main.png'), contentType: 'image/png' })
})

test('未安装 APK 禁用应用和 Launcher 操作，安装后按入口能力启用', async ({ app, page }) => {
  const initial = apkSnapshot()
  await app.open({ ...initial, compatibility: { ...initial.compatibility!, installedPackage: { installed: false, versionName: null, versionCode: null }, versionRelation: 'not-installed' } })
  await expect(page.getByRole('button', { name: '安装 / 更新' })).toBeEnabled()
  for (const name of ['启动应用', '停止应用', '重启应用', '设为开机应用', '验证开机应用']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
  }
  await app.publish({ ...initial, selectedApk: { ...apk, launchActivity: null, homeActivities: [], selectedHomeComponent: null } })
  await expect(page.getByRole('button', { name: '停止应用', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '启动应用', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '设为开机应用' })).toBeDisabled()
})
