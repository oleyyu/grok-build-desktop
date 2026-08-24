// electron-builder signs the .app in directories.output. OneDrive File Provider
// restamps com.apple.fileprovider.dir#N onto that tree and codesign --verify
// --deep then fails. When the project lives in CloudStorage, write dist outside it.
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = ['--mac', 'dmg', '--publish', 'never']
if (/CloudStorage|OneDrive/i.test(root)) {
  const out = join(homedir(), 'Library', 'Caches', 'GrokBuildDesktop', 'electron-dist')
  args.push(`-c.directories.output=${out}`)
  console.log(`OneDrive tree: writing dist to ${out}`)
}

const r = spawnSync(join(root, 'node_modules', '.bin', 'electron-builder'), args, {
  cwd: root,
  stdio: 'inherit',
})
process.exit(r.status ?? 1)
