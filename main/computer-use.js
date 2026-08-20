// Computer Use wiring. ACP mcpServers entries have no type field.

import { spawn, spawnSync, execFile } from 'node:child_process'
import { existsSync, statSync, mkdirSync, renameSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { computerUseDir } from './paths.js'

const execFileAsync = promisify(execFile)

export const CU_DIR = computerUseDir()
const SERVER_JS = join(CU_DIR, 'server.mjs')
const SWIFT_SRC = join(CU_DIR, 'input.swift')

export const CU_CACHE = join(homedir(), 'Library', 'Caches', 'GrokBuildDesktop', 'computer-use')
const INPUT_BIN = join(CU_CACHE, 'gbd-input')

export const CU_SERVER_NAME = 'computer'

export function available() {
  return existsSync(SERVER_JS) && existsSync(SWIFT_SRC)
}

function resolveNode() {
  const cands = [
    process.env.GBD_NODE_BIN,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter(Boolean)
  for (const c of cands) if (existsSync(c)) return { command: c, electronAsNode: false }
  try {
    const r = spawnSync('/usr/bin/which', ['node'], { encoding: 'utf8', timeout: 5000 })
    const p = (r.stdout || '').trim()
    if (r.status === 0 && p && existsSync(p)) return { command: p, electronAsNode: false }
  } catch {}
  return { command: process.execPath, electronAsNode: true }
}

export function mcpServerEntry() {
  const { command, electronAsNode } = resolveNode()
  const env = [
    { name: 'GBD_CU_CACHE', value: CU_CACHE },
    { name: 'GBD_CU_FAKE_SHOT', value: '' },
  ]
  if (electronAsNode) env.push({ name: 'ELECTRON_RUN_AS_NODE', value: '1' })
  return { name: CU_SERVER_NAME, command, args: [SERVER_JS], env }
}

function needsCompile() {
  try {
    return !(existsSync(INPUT_BIN) && statSync(INPUT_BIN).mtimeMs >= statSync(SWIFT_SRC).mtimeMs)
  } catch { return true }
}

let compileInflight = null
let compileFailAt = 0

function compileInputBin(log) {
  return new Promise((resolve) => {
    try {
      mkdirSync(CU_CACHE, { recursive: true })
      log('computer-use: 后台编译 gbd-input…')
      // Compile to a temp path then rename (MCP may compile the same binary).
      const tmpOut = INPUT_BIN + '.' + process.pid + '.tmp'
      const p = spawn('xcrun', ['swiftc', '-O', SWIFT_SRC, '-o', tmpOut], { stdio: 'ignore' })
      let settled = false
      const done = (ok) => {
        if (settled) return
        settled = true
        if (!ok) compileFailAt = Date.now()
        resolve(ok)
      }
      p.on('exit', (code) => {
        let ok = false
        if (code === 0 && existsSync(tmpOut)) {
          try { renameSync(tmpOut, INPUT_BIN); ok = true; log('computer-use: gbd-input 编译完成') }
          catch (e) { log('computer-use: 安装编译产物失败 ' + e.message) }
        } else {
          log('computer-use: gbd-input 编译失败 code=' + code)
        }
        try { if (existsSync(tmpOut)) rmSync(tmpOut, { force: true }) } catch {}
        done(ok)
      })
      p.on('error', (e) => { log('computer-use: 编译启动失败 ' + e.message); done(false) })
    } catch (e) {
      log('computer-use: prewarm 异常 ' + e.message)
      compileFailAt = Date.now()
      resolve(false)
    }
  })
}

export async function prewarm(log = () => {}) {
  try {
    if (available()) {
      if (!needsCompile()) {
        log('computer-use: gbd-input 已就绪')
      } else if (compileInflight) {
        await compileInflight
      } else if (Date.now() - compileFailAt >= 60_000) {
        compileInflight = compileInputBin(log).finally(() => { compileInflight = null })
        await compileInflight
      }
    }
  } catch (e) {
    log('computer-use: prewarm 异常 ' + e.message)
  }
  return await probe()
}

export const prewarmAsync = prewarm

let probeSeq = 0

export async function probe() {
  const out = {
    available: available(),
    binaryReady: existsSync(INPUT_BIN),
    accessibility: null, // null = unknown, not "denied"
    screenRecording: false,
    display: null,
    grokAlwaysApprove: false,
    error: null,
  }
  if (!out.available) { out.error = '找不到 computer-use/ 目录下的文件'; return out }

  // Unique name, no leading dot: screencapture refuses hidden files but still exits 0.
  const tmp = join(CU_CACHE, `probe-${process.pid}-${probeSeq++}.png`)
  try { mkdirSync(CU_CACHE, { recursive: true }) } catch {}

  const [caps, shot] = await Promise.all([
    out.binaryReady
      ? execFileAsync(INPUT_BIN, ['caps'], { encoding: 'utf8', timeout: 4000 })
        .catch((e) => ({ stdout: e?.stdout || '', __err: e }))
      : Promise.resolve(null),
    execFileAsync('/usr/sbin/screencapture', ['-x', '-t', 'png', '-R', '0,0,1,1', tmp], { timeout: 4000 })
      .then(() => true).catch(() => false),
  ])

  if (caps) {
    try {
      const j = JSON.parse(String(caps.stdout || '').trim().split('\n').pop() || '{}')
      if (j.ok) {
        out.accessibility = !!j.postEventAccess
        const main = (j.displays || []).find(d => d.main) || (j.displays || [])[0]
        if (main) out.display = { pointsW: main.pointsW, pointsH: main.pointsH, scale: main.scale }
      } else if (caps.__err) {
        out.error = String(caps.__err.message || caps.__err)
      }
    } catch (e) { out.error = String(e.message || e) }
  }

  out.screenRecording = shot && existsSync(tmp)
  try { if (existsSync(tmp)) rmSync(tmp, { force: true }) } catch {}

  try {
    const cfg = join(homedir(), '.grok', 'config.toml')
    if (existsSync(cfg)) {
      const txt = readFileSync(cfg, 'utf8')
      out.grokAlwaysApprove = /^\s*permission_mode\s*=\s*["'](always-approve|bypassPermissions|dontAsk)["']/m.test(txt)
    }
  } catch {}

  return out
}

export function readShot(id) {
  if (!/^[0-9a-f]{16}$/.test(String(id || ''))) return null
  const p = join(CU_CACHE, 'shots', id + '.png')
  if (!existsSync(p)) return null
  try {
    const buf = readFileSync(p)
    if (buf.length > 12 * 1024 * 1024) return null
    return 'data:image/png;base64,' + buf.toString('base64')
  } catch { return null }
}

export function openPrivacyPane(which) {
  const anchor = which === 'screen'
    ? 'Privacy_ScreenCapture'
    : 'Privacy_Accessibility'
  execFile('open', [`x-apple.systempreferences:com.apple.preference.security?${anchor}`], () => {})
}
