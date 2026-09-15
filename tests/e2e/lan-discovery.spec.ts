import type { Page } from '@playwright/test'
import { test, expect, snapshot } from './fixtures'

const networks = [{ id: 'wifi', label: 'Wi-Fi · 192.168.2.5 / 255.255.255.0', address: '192.168.2.5', netmask: '255.255.255.0' }]

async function fillScanPort(page: Page, value: string) {
  const input = page.getByRole('spinbutton', { name: '扫描端口' })
  if (!await input.isVisible()) await page.getByText('高级选项', { exact: true }).click()
  await input.fill(value)
}

test('自动搜索无需填写端口，发现动态 ADB 服务并按实际端口连接', async ({ app, page }) => {
  const tcp = snapshot({ connectionMode: 'tcp', devices: [], selectedSerial: null, selectedDevice: null })
  await app.open(tcp)
  await app.reply('listLanNetworks', networks)
  await app.reply('searchLan', { cancelled: false, warnings: [], candidates: [
    { host: '192.168.2.10', port: 37123, source: 'mdns', pairing: false },
    { host: '192.168.2.11', port: 5555, source: 'tcp', pairing: false },
    { host: '192.168.2.10', port: 39123, source: 'mdns', pairing: true }
  ] })
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await app.expectCalls('searchLan', [['wifi', 5555]])
  await expect(page.getByRole('spinbutton', { name: '扫描端口' })).toBeHidden()
  await expect(page.getByText('发现 ADB 服务', { exact: true })).toBeVisible()
  await expect(page.getByText('发现开放端口 · 连接时验证是否为安卓设备')).toBeVisible()
  await expect(page.getByRole('button', { name: '需先配对 192.168.2.10:39123', exact: true })).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath('automatic-discovery.png'), fullPage: true })
  const connected = { ...snapshot().selectedDevice!, serial: '192.168.2.10:37123', transport: 'tcp' as const }
  await app.reply('connectTcp', { ...tcp, devices: [connected], selectedSerial: connected.serial, selectedDevice: connected })
  await page.getByRole('button', { name: '连接此设备 192.168.2.10:37123', exact: true }).click()
  await app.expectCalls('connectTcp', [[{ host: '192.168.2.10', port: 37123 }]])
  await expect(page.getByRole('button', { name: '已连接 192.168.2.10:37123', exact: true })).toBeDisabled()
})

test('高级选项收起保留端口，非法端口阻止搜索并可修正', async ({ app, page }) => {
  await app.open(snapshot({ connectionMode: 'tcp' }))
  await app.reply('listLanNetworks', networks)
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await expect(page.getByText(/仍未找到时，可在高级选项填写设备当前的调试端口/)).toBeVisible()
  await fillScanPort(page, '5556')
  await page.screenshot({ path: test.info().outputPath('advanced-port.png'), fullPage: true })
  await page.getByText('高级选项', { exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: '扫描端口' })).toBeHidden()
  await expect(page.getByText('TCP 扫描端口：5556', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '开始搜索', exact: true }).click()
  await app.expectCalls('searchLan', [['wifi', 5555], ['wifi', 5556]])
  await fillScanPort(page, '65536')
  await page.getByText('高级选项', { exact: true }).click()
  await page.getByRole('button', { name: '开始搜索', exact: true }).click()
  const port = page.getByRole('spinbutton', { name: '扫描端口' })
  await expect(port).toBeVisible()
  expect(await port.evaluate((el: HTMLInputElement) => el.validity.rangeOverflow)).toBe(true)
  await app.expectCalls('searchLan', [['wifi', 5555], ['wifi', 5556]])
  await fillScanPort(page, '37123')
  await page.getByRole('button', { name: '开始搜索', exact: true }).click()
  await app.expectCalls('searchLan', [['wifi', 5555], ['wifi', 5556], ['wifi', 37123]])
})

test('搜索结果卡片一键连接并显示成功状态', async ({ app, page }) => {
  const tcp = snapshot({ connectionMode: 'tcp', devices: [], selectedSerial: null, selectedDevice: null })
  await app.open(tcp)
  await app.reply('listLanNetworks', networks)
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await app.reply('searchLan', { cancelled: false, warnings: [], candidates: [
    { host: '192.168.2.10', port: 5555, source: 'tcp', pairing: false },
    { host: '192.168.2.11', port: 32123, source: 'mdns', pairing: true }
  ] })
  await fillScanPort(page, '5556')
  await page.getByRole('button', { name: '开始搜索', exact: true }).click()
  await app.expectCalls('searchLan', [['wifi', 5555], ['wifi', 5556]])
  await expect(page.getByText('搜索完成，找到 2 个候选地址。')).toBeVisible()
  await expect(page.getByRole('button', { name: '需先配对 192.168.2.11:32123', exact: true })).toBeDisabled()
  await expect(page.getByRole('heading', { name: '发现的设备 2' })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('lan-ready.png'), fullPage: true })
  const connected = { ...snapshot().selectedDevice!, serial: '192.168.2.10:5555', transport: 'tcp' as const }
  await app.reply('connectTcp', { ...tcp, devices: [connected], selectedSerial: connected.serial, selectedDevice: connected })
  await page.getByRole('button', { name: '连接此设备 192.168.2.10:5555', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '设备 IP' })).toHaveValue('192.168.2.10')
  await expect(page.getByRole('spinbutton', { name: '端口', exact: true })).toHaveValue('5555')
  await app.expectCalls('connectTcp', [[{ host: '192.168.2.10', port: 5555 }]])
  await expect(page.getByRole('button', { name: '已连接 192.168.2.10:5555', exact: true })).toBeDisabled()
  await expect(page.getByText('已连接，可以安装应用或操作设备。')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('lan-results.png'), fullPage: true })
})

test('空结果和搜索失败可重试', async ({ app, page }) => {
  await app.open(snapshot({ connectionMode: 'tcp' }))
  await app.reply('listLanNetworks', networks)
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await app.reject('searchLan', '网卡地址已变化，请重新打开搜索。')
  await page.getByRole('button', { name: '开始搜索', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('网卡地址已变化')
  await page.getByRole('button', { name: '开始搜索', exact: true }).click()
  await expect(page.getByText('搜索完成，找到 0 个候选地址。')).toBeVisible()
})

test('搜索过程中禁用重复搜索并可取消', async ({ app, page }) => {
  await app.open(snapshot({ connectionMode: 'tcp' }))
  await app.reply('listLanNetworks', networks)
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await page.evaluate(() => {
    window.adbTool.searchLan = () => new Promise((resolve) => {
      window.adbTool.cancelLanSearch = async () => { resolve({ candidates: [], cancelled: true, warnings: [] }) }
    })
  })
  await page.getByRole('button', { name: '开始搜索', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在搜索…', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '取消搜索', exact: true }).click()
  await expect(page.getByText('重新验证已取消，当前显示历史结果。')).toBeVisible()
  await expect(page.getByText(/历史结果尚未重新验证/)).toBeVisible()
  await expect(page.getByRole('button', { name: '开始搜索', exact: true })).toBeEnabled()
})


test('卡片连接中禁止重复操作，失败后在原位置重试', async ({ app, page }) => {
  await app.open(snapshot({ connectionMode: 'tcp' }))
  await app.reply('listLanNetworks', networks)
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await app.reply('searchLan', { cancelled: false, warnings: [], candidates: [
    { host: '192.168.2.10', port: 5555, source: 'mdns', pairing: false },
    { host: '192.168.2.12', port: 5555, source: 'tcp', pairing: false }
  ] })
  await page.getByRole('button', { name: '开始搜索', exact: true }).click()
  await page.evaluate(() => {
    const original = window.adbTool.connectTcp
    window.adbTool.connectTcp = async (request) => {
      await new Promise((resolve) => { window.adbTool.cancelLanSearch = async () => { resolve(undefined) } })
      window.adbTool.connectTcp = original
      throw new Error('设备尚未授权，请在屏幕上确认。')
    }
  })
  await page.getByRole('button', { name: '连接此设备 192.168.2.10:5555', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在连接 192.168.2.10:5555', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '连接此设备 192.168.2.12:5555', exact: true })).toBeDisabled()
  await page.evaluate(() => window.adbTool.cancelLanSearch())
  const card = page.getByRole('article', { name: '设备 192.168.2.10:5555', exact: true })
  await expect(card.getByRole('alert')).toHaveText('设备尚未授权，请在屏幕上确认。')
  await card.getByRole('button', { name: '重试连接 192.168.2.10:5555', exact: true }).click()
  await app.expectCalls('connectTcp', [[{ host: '192.168.2.10', port: 5555 }]])
  await expect(card.getByRole('alert')).toContainText('连接未成功')
})

test('首次点击立即按第一张网卡和默认端口搜索', async ({ app, page }) => {
  await app.open(snapshot({ connectionMode: 'tcp' }))
  const items = [...networks, { ...networks[0]!, id: 'ethernet' }]
  await app.reply('listLanNetworks', items)
  await app.reply('searchLan', { candidates: [{ host: '192.168.2.10', port: 5555, source: 'mdns', pairing: false }], cancelled: false, warnings: [] })
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await app.expectCalls('searchLan', [['wifi', 5555]])
  await expect(page.getByRole('button', { name: '连接此设备 192.168.2.10:5555', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('auto-search.png'), fullPage: true })
  await page.getByRole('combobox', { name: '电脑使用的网络' }).selectOption('ethernet')
  await fillScanPort(page, '5556')
  await page.getByRole('button', { name: '开始搜索', exact: true }).click()
  await app.expectCalls('searchLan', [['wifi', 5555], ['ethernet', 5556]])
  await app.reply('listLanNetworks', items)
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await app.expectCalls('searchLan', [['wifi', 5555], ['ethernet', 5556], ['wifi', 5555]])
})

test('无网卡不扫描，读取网卡时可取消且不会迟到启动扫描', async ({ app, page }) => {
  await app.open(snapshot({ connectionMode: 'tcp' }))
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await expect(page.getByText('没有可用的 IPv4 网卡，请检查网络连接。')).toBeVisible()
  await app.expectCalls('searchLan', [])
  await page.evaluate(() => {
    window.adbTool.listLanNetworks = () => new Promise((resolve) => {
      window.adbTool.cancelLanSearch = async () => { resolve([{ id: 'wifi', label: 'Wi-Fi', address: '192.168.2.5', netmask: '255.255.255.0' }]) }
    })
  })
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await expect(page.getByRole('button', { name: '搜索局域网设备', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '取消搜索', exact: true }).click()
  await expect(page.getByText('搜索已取消，找到 0 个候选地址。')).toBeVisible()
  await app.expectCalls('searchLan', [])
})

test('搜索面板可折叠，展开保留结果且不重复扫描', async ({ app, page }) => {
  await app.open(snapshot({ connectionMode: 'tcp' }))
  await app.reply('listLanNetworks', networks)
  await app.reply('searchLan', { candidates: [{ host: '192.168.2.10', port: 5555, source: 'mdns', pairing: false }], cancelled: false, warnings: [] })
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  const toggle = page.getByRole('button', { name: /局域网设备 · 1 个候选地址/ })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('region', { name: '发现的设备', exact: true })).toBeHidden()
  await expect(page.getByRole('combobox', { name: '电脑使用的网络' })).toBeHidden()
  await page.screenshot({ path: test.info().outputPath('lan-collapsed.png'), fullPage: true })
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '连接此设备 192.168.2.10:5555', exact: true })).toBeVisible()
  await app.expectCalls('searchLan', [['wifi', 5555]])
})

for (const condition of ['network', 'port'] as const) {
  test(`修改搜索条件 ${condition} 清空旧结果且保留设备连接`, async ({ app, page }) => {
    const device = { ...snapshot().selectedDevice!, serial: '192.168.2.10:5555', transport: 'tcp' as const }
    await app.open(snapshot({ connectionMode: 'tcp', devices: [device], selectedSerial: device.serial, selectedDevice: device }))
    await app.reply('listLanNetworks', [...networks, { ...networks[0]!, id: 'ethernet' }])
    await app.reply('searchLan', { candidates: [{ host: '192.168.2.10', port: 5555, source: 'mdns', pairing: false }], cancelled: false, warnings: ['旧扫描警告'] })
    await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
    await expect(page.getByRole('button', { name: '已连接 192.168.2.10:5555', exact: true })).toBeVisible()
    if (condition === 'network') await page.getByRole('combobox', { name: '电脑使用的网络' }).selectOption('ethernet')
    else await fillScanPort(page, '5556')
    await expect(page.getByRole('region', { name: '发现的设备', exact: true })).toHaveCount(0)
    await expect(page.getByText('旧扫描警告')).toHaveCount(0)
    await expect(page.getByText('搜索完成，找到 1 个候选地址。')).toHaveCount(0)
    await expect(page.getByText('搜索条件已变更，请点击开始搜索')).toBeVisible()
    await expect(page.getByRole('combobox', { name: '当前设备' })).toHaveValue(device.serial)
    await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeEnabled()
    await app.expectCalls('searchLan', [['wifi', 5555]])
    await app.expectCalls('connectTcp', [])
    await page.getByRole('button', { name: '开始搜索', exact: true }).click()
    await app.expectCalls('searchLan', [['wifi', 5555], [condition === 'network' ? 'ethernet' : 'wifi', condition === 'port' ? 5556 : 5555]])
    await expect(page.getByText('搜索条件已变更，请点击开始搜索')).toHaveCount(0)
    await expect(page.getByText('搜索完成，找到 0 个候选地址。')).toBeVisible()
  })
}

for (const condition of ['network', 'port'] as const) {
  test(`切回 ${condition} 显示历史并自动验证，移除失效候选`, async ({ app, page }) => {
    await app.open(snapshot({ connectionMode: 'tcp' }))
    await app.reply('listLanNetworks', [...networks, { ...networks[0]!, id: 'ethernet' }])
    await app.reply('searchLan', { candidates: [{ host: '192.168.2.10', port: 5555, source: 'mdns', pairing: false }], cancelled: false, warnings: [] })
    await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
    await expect(page.getByRole('article', { name: '设备 192.168.2.10:5555' })).toBeVisible()
    if (condition === 'network') await page.getByRole('combobox', { name: '电脑使用的网络' }).selectOption('ethernet')
    else await fillScanPort(page, '5556')
    await expect(page.getByRole('region', { name: '发现的设备' })).toHaveCount(0)
    await page.evaluate(() => {
      const original = window.adbTool.searchLan
      window.adbTool.searchLan = async (id, port) => {
        await new Promise((resolve) => { window.adbTool.cancelLanSearch = async () => { resolve(undefined) } })
        return original(id, port)
      }
    })
    if (condition === 'network') await page.getByRole('combobox', { name: '电脑使用的网络' }).selectOption('wifi')
    else await fillScanPort(page, '5555')
    await expect(page.getByText(/上次发现于.*正在重新验证/)).toBeVisible()
    await expect(page.getByRole('button', { name: '连接此设备 192.168.2.10:5555' })).toBeDisabled()
    await page.evaluate(() => window.adbTool.cancelLanSearch())
    await expect(page.getByText('搜索完成，找到 0 个候选地址。')).toBeVisible()
    await expect(page.getByRole('article', { name: '设备 192.168.2.10:5555' })).toHaveCount(0)
    await expect(page.getByText(/上次发现于/)).toHaveCount(0)
    await app.expectCalls('searchLan', [['wifi', 5555], ['wifi', 5555]])
  })
}

test('缓存验证失败保留历史标记，网段变化不复用旧缓存', async ({ app, page }) => {
  await app.open(snapshot({ connectionMode: 'tcp' }))
  const items = [...networks, { ...networks[0]!, id: 'ethernet' }]
  await app.reply('listLanNetworks', items)
  await app.reply('searchLan', { candidates: [{ host: '192.168.2.10', port: 5555, source: 'mdns', pairing: false }], cancelled: false, warnings: [] })
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await expect(page.getByRole('article', { name: '设备 192.168.2.10:5555' })).toBeVisible()
  await page.getByRole('combobox', { name: '电脑使用的网络' }).selectOption('ethernet')
  await app.reject('searchLan', '当前网络不可达')
  await page.getByRole('combobox', { name: '电脑使用的网络' }).selectOption('wifi')
  await expect(page.getByRole('alert')).toHaveText('Error: 当前网络不可达')
  await expect(page.getByText(/历史结果尚未重新验证/)).toBeVisible()
  await expect(page.getByRole('button', { name: '连接此设备 192.168.2.10:5555' })).toBeDisabled()
  await app.reply('listLanNetworks', [{ ...networks[0]!, address: '192.168.3.5' }])
  await app.reject('searchLan', '扫描失败')
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Error: 扫描失败')
  await expect(page.getByText(/上次发现于/)).toHaveCount(0)
  await expect(page.getByRole('region', { name: '发现的设备' })).toHaveCount(0)
})

test('切换网络更新电脑地址和搜索范围，明确保留当前连接', async ({ app, page }) => {
  const device = { ...snapshot().selectedDevice!, serial: '192.168.2.10:5555', transport: 'tcp' as const }
  await app.open(snapshot({ connectionMode: 'tcp', devices: [device], selectedDevice: device, selectedSerial: device.serial }))
  await app.reply('listLanNetworks', [...networks, { id: 'ethernet', label: '以太网 · 10.0.8.7 / 255.255.254.0', address: '10.0.8.7', netmask: '255.255.254.0' }])
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await expect(page.getByRole('button', { name: '开始搜索', exact: true })).toBeEnabled()
  await page.getByRole('combobox', { name: '电脑使用的网络' }).selectOption('ethernet')
  const context = page.getByLabel('当前搜索网络', { exact: true })
  await expect(context).toContainText('10.0.8.7')
  await expect(context).toContainText('10.0.8.0/23')
  await expect(context).toContainText('等待搜索')
  await expect(page.getByText('当前连接：192.168.2.10:5555')).toBeVisible()
  await expect(page.getByRole('combobox', { name: '当前设备' })).toHaveValue(device.serial)
  await page.screenshot({ path: test.info().outputPath('network-switch.png'), fullPage: true })
  await page.getByRole('button', { name: '开始搜索', exact: true }).click()
  await expect(context).toContainText('搜索完成')
  await expect(page.getByRole('region', { name: '发现的设备' })).toContainText('以太网 · 10.0.8.0/23 · ADB 自动发现 + TCP 端口 5555')
})
