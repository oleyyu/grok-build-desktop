// electron-builder signs the .app in directories.output. OneDrive File Provider
// restamps com.apple.fileprovider.dir#N onto that tree and codesign --verify
// --deep then fails. When the project lives in CloudStorage, write dist outside it.
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const identity = 'Developer ID Application: Lijuan Zhou (7WD5U8V976)'
const teamId = '7WD5U8V976'
const profile = process.env.APPLE_KEYCHAIN_PROFILE || 'grok-build-desktop'

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1)
}

function notaryAuth() {
  if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) {
    return ['--key', process.env.APPLE_API_KEY, '--key-id', process.env.APPLE_API_KEY_ID, '--issuer', process.env.APPLE_API_ISSUER]
  }
  if (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    return [
      '--apple-id', process.env.APPLE_ID,
      '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id', process.env.APPLE_TEAM_ID || teamId,
    ]
  }
  return ['--keychain-profile', profile]
}

function haveNotaryAuth() {
  if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) return true
  if (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD) return true
  const r = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', profile], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  return r.status === 0
}

const args = ['--mac', 'dmg', '--arm64', '--x64', '--publish', 'never']
if (/CloudStorage|OneDrive/i.test(root)) {
  const out = join(homedir(), 'Library', 'Caches', 'GrokBuildDesktop', 'electron-dist')
  args.push(`-c.directories.output=${out}`)
  console.log(`OneDrive tree: writing dist to ${out}`)
}

run(join(root, 'node_modules', '.bin', 'electron-builder'), args, { cwd: root })

const outDir = args.find((a) => a.startsWith('-c.directories.output='))?.slice('-c.directories.output='.length)
  || join(root, 'dist')
const prefix = `Grok-Build-Desktop-${version}-mac-`
const dmgs = readdirSync(outDir).filter((name) => name.startsWith(prefix) && name.endsWith('.dmg'))
if (!dmgs.length) {
  console.error(`no ${prefix}*.dmg in ${outDir}`)
  process.exit(1)
}

if (!haveNotaryAuth()) {
  console.error(`公证凭证找不到。任选一种：
  1) xcrun notarytool store-credentials ${profile} --apple-id YOUR@EMAIL --team-id ${teamId}
     （会提示输入 appleid.apple.com 的应用专用密码）
  2) 环境变量 APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID=${teamId}
  3) 环境变量 APPLE_API_KEY（.p8 路径）+ APPLE_API_KEY_ID + APPLE_API_ISSUER`)
  process.exit(1)
}

const auth = notaryAuth()
for (const name of dmgs) {
  const dmg = join(outDir, name)
  console.log('signing DMG', dmg)
  run('codesign', ['--force', '--sign', identity, '--timestamp', dmg])
  console.log('notarizing DMG', dmg)
  run('xcrun', ['notarytool', 'submit', dmg, '--wait', ...auth])
  console.log('stapling DMG', dmg)
  run('xcrun', ['stapler', 'staple', dmg])
  run('xcrun', ['stapler', 'validate', dmg])
}
