import { test, expect, snapshot } from './fixtures'

const networks = [{ id: 'wifi', label: 'Wi-Fi · 192.168.2.5 / 255.255.255.0', address: '192.168.2.5', netmask: '255.255.255.0' }]

test('搜索结果卡片一键连接并显示成功状态', async ({ app, page }) => {
  const tcp = snapshot({ connectionMode: 'tcp', devices: [], selectedSerial: null, selectedDevice: null })
  await app.open(tcp)
  await app.reply('listLanNetworks', networks)
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await app.reply('searchLan', { cancelled: false, warnings: [], candidates: [
    { host: '192.168.2.10', port: 5555, source: 'tcp', pairing: false },
    { host: '192.168.2.11', port: 32123, source: 'mdns', pairing: true }
  ] })
  await page.getByRole('spinbutton', { name: '扫描端口' }).fill('5556')
  await page.getByRole('button', { name: '重新搜索', exact: true }).click()
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
  await page.getByRole('button', { name: '重新搜索', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('网卡地址已变化')
  await page.getByRole('button', { name: '重新搜索', exact: true }).click()
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
  await page.getByRole('button', { name: '重新搜索', exact: true }).click()
  await expect(page.getByRole('button', { name: '重新搜索', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '取消搜索', exact: true }).click()
  await expect(page.getByText('搜索已取消，找到 0 个候选地址。')).toBeVisible()
})


test('卡片连接中禁止重复操作，失败后在原位置重试', async ({ app, page }) => {
  await app.open(snapshot({ connectionMode: 'tcp' }))
  await app.reply('listLanNetworks', networks)
  await page.getByRole('button', { name: '搜索局域网设备', exact: true }).click()
  await app.reply('searchLan', { cancelled: false, warnings: [], candidates: [
    { host: '192.168.2.10', port: 5555, source: 'mdns', pairing: false },
    { host: '192.168.2.12', port: 5555, source: 'tcp', pairing: false }
  ] })
  await page.getByRole('button', { name: '重新搜索', exact: true }).click()
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
  await page.getByRole('spinbutton', { name: '扫描端口' }).fill('5556')
  await page.getByRole('button', { name: '重新搜索', exact: true }).click()
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
