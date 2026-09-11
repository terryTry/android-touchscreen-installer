import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { hashFile } from './file-hash'

it('使用实际文件内容计算 SHA-256，文件不存在时拒绝校验', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apk-hash-'))
  try {
    const path = join(directory, 'fixture.apk')
    await writeFile(path, 'abc')
    expect(await hashFile(path)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    await expect(hashFile(join(directory, 'missing.apk'))).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
