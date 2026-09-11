import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function releaseMetadata(tag, pkg, lock) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?$/.test(tag)) {
    throw new Error('仅支持正式 tag vX.Y.Z 和 RC tag vX.Y.Z-rc.N')
  }
  const version = tag.slice(1)
  if (pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error('tag、package.json 和 package-lock.json 的版本必须完全一致')
  }
  return { version, prerelease: version.includes('-rc.') }
}

export function verifyAssets(assets, expected) {
  for (const [name, digest] of expected) {
    if (assets.find((asset) => asset.name === name)?.digest !== digest) {
      throw new Error(`${name} 的 GitHub SHA-256 未匹配，保留草稿，不发布`)
    }
  }
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function main() {
  const tag = process.env.RELEASE_TAG ?? ''
  const metadata = releaseMetadata(tag,
    JSON.parse(readFileSync('package.json', 'utf8')),
    JSON.parse(readFileSync('package-lock.json', 'utf8')))
  if (process.argv[2] === 'validate') {
    console.log(`已校验 ${tag}，类型：${metadata.prerelease ? '预发布' : '正式发布'}`)
    return
  }
  if (process.argv[2] !== 'publish') throw new Error('参数必须为 validate 或 publish')
  const installer = `android-touchscreen-installer-${metadata.version}-win-x64.exe`
  const files = [installer, `${installer}.blockmap`]
  const hash = (name) => createHash('sha256').update(readFileSync(`release/${name}`)).digest('hex')
  const sums = files.map((name) => `${hash(name)}  ${name}\n`).join('')
  writeFileSync('release/SHA256SUMS.txt', sums)
  files.push('SHA256SUMS.txt')
  const expected = new Map(files.map((name) => [name, `sha256:${hash(name)}`]))

  // 已发布版本不覆盖；失败留下的草稿允许重新上传并完成校验。
  const repo = process.env.GH_REPO
  if (!repo) throw new Error('缺少 GH_REPO')
  const endpoint = `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
  const releases = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`)).flat()
  const existing = releases.find((release) => release.tag_name === tag)
  if (existing && !existing.draft) throw new Error(`${tag} 已发布，禁止覆盖，请使用新版本 tag`)
  if (!existing) {
    gh('release', 'create', tag, '--verify-tag', '--draft', '--title', tag, '--generate-notes',
      ...(metadata.prerelease ? ['--prerelease'] : []))
  }
  gh('release', 'upload', tag, ...files.map((name) => `release/${name}`), '--clobber')
  const uploaded = JSON.parse(gh('api', endpoint))
  verifyAssets(uploaded.assets, expected)
  gh('release', 'edit', tag, '--draft=false', `--prerelease=${metadata.prerelease}`,
    ...(metadata.prerelease ? ['--latest=false'] : []))
  console.log(`已发布 ${tag}，所有制品 SHA-256 校验通过`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
