// electron-builder signs the .app in directories.output. OneDrive File Provider
// restamps com.apple.fileprovider.dir#N onto that tree and codesign --verify
// --deep then fails. When the project lives in CloudStorage, write dist outside it.
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = ['--mac', 'dmg', '--arm64', '--x64', '--publish', 'never']
if (/CloudStorage|OneDrive/i.test(root)) {
  const out = join(homedir(), 'Library', 'Caches', 'GrokBuildDesktop', 'electron-dist')
  args.push(`-c.directories.output=${out}`)
  console.log(`OneDrive tree: writing dist to ${out}`)
}

const r = spawnSync(join(root, 'node_modules', '.bin', 'electron-builder'), args, {
  cwd: root,
  stdio: 'inherit',
})
if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1)

const { readdirSync } = await import('node:fs')
const outDir = args.find((a) => a.startsWith('-c.directories.output='))?.slice('-c.directories.output='.length)
  || join(root, 'dist')
const identity = 'Developer ID Application: Lijuan Zhou (7WD5U8V976)'
for (const name of readdirSync(outDir)) {
  if (!name.endsWith('.dmg')) continue
  const dmg = join(outDir, name)
  console.log('signing DMG', dmg)
  const s = spawnSync('codesign', ['--force', '--sign', identity, '--timestamp', dmg], { stdio: 'inherit' })
  if ((s.status ?? 1) !== 0) process.exit(s.status ?? 1)
}
