import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseMetadata, verifyAssets } from './github-release.mjs'

const data = (version) => [{ version }, { version, packages: { '': { version } } }]

test('正式与 RC tag 使用对应版本并区分发布类型', () => {
  assert.deepEqual(releaseMetadata('v0.2.1', ...data('0.2.1')), { version: '0.2.1', prerelease: false })
  assert.deepEqual(releaseMetadata('v0.3.0-rc.1', ...data('0.3.0-rc.1')), { version: '0.3.0-rc.1', prerelease: true })
})
test('拒绝其他 tag 格式', () => {
  for (const tag of ['0.2.1', 'v0.2', 'v01.2.3', 'v0.2.1-beta.1', 'v0.2.1-rc', 'v0.2.1-rc.01', 'v0.2.1+build']) {
    assert.throws(() => releaseMetadata(tag, ...data('0.2.1')))
  }
})
test('拒绝 package 或锁文件版本不一致', () => {
  assert.throws(() => releaseMetadata('v0.2.2', ...data('0.2.1')))
  const [pkg, lock] = data('0.2.1')
  lock.packages[''].version = '0.2.0'
  assert.throws(() => releaseMetadata('v0.2.1', pkg, lock))
})

test('制品缺失或哈希不一致时阻止发布', () => {
  const expected = new Map([['installer.exe', 'sha256:abc']])
  assert.doesNotThrow(() => verifyAssets([{ name: 'installer.exe', digest: 'sha256:abc' }], expected))
  assert.throws(() => verifyAssets([], expected))
  assert.throws(() => verifyAssets([{ name: 'installer.exe', digest: null }], expected))
  assert.throws(() => verifyAssets([{ name: 'installer.exe', digest: 'sha256:wrong' }], expected))
})
