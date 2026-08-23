
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, renameSync, copyFileSync, unlinkSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { app } from 'electron'

const SOURCE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let logSink = { warn: (m) => console.warn(m) }
export function setSettingsLogger(l) {
  if (l && typeof l.warn === 'function') logSink = l
}

export function dataRoot() {
  if (process.env.GROK_DESKTOP_HOME) return process.env.GROK_DESKTOP_HOME
  if (app.isPackaged) return join(app.getPath('userData'), 'home')
  return join(SOURCE_ROOT, 'home')
}

const DEFAULT_SETTINGS = {
  ui: {
    theme: 'system',            // system | light | dark
    language: 'en',
    keepThoughts: false,
    userName: null,
    multiline: false,
    timestamps: false,
    compactMode: false,
    planUsage: 'separate',      // separate | merged  (multi-account plan limits)
  },
  engine: {
    model: null,
    effort: null,
    permissionMode: 'ask',      // ask | auto-safe | always-approve
    computerUse: false,
    // 只对共享鼠标模式有意义：独立指针模式下本 App 的窗口一律按 pid 排除，Grok 选不到它
    cuHideApp: true,            // computer-use 干活时隐藏本 App 并挡出截图（false = 需要 Grok 看见/操作本 App 时用）
    cuGhost: true,              // 独立指针模式：Grok 用辅助功能操作单个窗口，不碰用户光标（false = 共享真鼠标）
    keepAwake: true,            // prevent idle system sleep while Grok is generating
  },
  workspace: {
    lastCwd: null,
    recentCwds: [],
  },
  profile: {
    fullName: null,
    nickname: null,             // What should Grok call you?
    work: null,                 // What best describes your work?
    instructions: null,
  },
  presets: {
    default: null,
  },
  providers: {
    // xinyuanai:
    //   displayName: XinyuanAI
    //   baseURL: https://example.com/v1
    //   apiKeyEnv: XINYUANAI_API_KEY
    active: null,
  },
}

const THEMES = ['system', 'light', 'dark']
const LANGUAGES = ['en', 'zh']
const PLAN_USAGE = ['separate', 'merged']
const PERMISSION_MODES = ['ask', 'auto-safe', 'always-approve']
const EFFORTS = ['low', 'medium', 'high', 'xhigh']

function clampEnums(s) {
  const fix = (obj, key, allow, def, nullable = false) => {
    if (!obj || typeof obj !== 'object') return
    const v = obj[key]
    if (nullable && (v === null || v === undefined)) { obj[key] = null; return }
    if (allow.includes(v)) return
    logSink.warn(`[settings] 非法的 ${key}=${JSON.stringify(v)}，已回落到 ${JSON.stringify(def)}`)
    obj[key] = def
  }
  fix(s.ui, 'theme', THEMES, 'system')
  fix(s.ui, 'language', LANGUAGES, 'en')
  fix(s.ui, 'planUsage', PLAN_USAGE, 'separate')
  fix(s.engine, 'permissionMode', PERMISSION_MODES, 'ask')
  fix(s.engine, 'effort', EFFORTS, null, true)
  // 这几个开关在使用侧都按 `!== false` / `=== false` 读：yaml 里写成字符串 "false" 反而算开着，
  // 所以非 boolean 一律拍回默认 true
  if (s.engine && typeof s.engine.keepAwake !== 'boolean') s.engine.keepAwake = true
  if (s.engine && typeof s.engine.cuHideApp !== 'boolean') s.engine.cuHideApp = true
  if (s.engine && typeof s.engine.cuGhost !== 'boolean') s.engine.cuGhost = true
  if (s.workspace) {
    const rec = s.workspace.recentCwds
    if (!Array.isArray(rec)) s.workspace.recentCwds = []
    else {
      const seen = new Set()
      const out = []
      for (const p of rec) {
        if (typeof p !== 'string' || !p || seen.has(p)) continue
        seen.add(p)
        out.push(p)
        if (out.length >= 12) break
      }
      s.workspace.recentCwds = out
    }
  }
  return s
}

const RECENT_CWD_CAP = 12

export function touchWorkspace(settings, cwd) {
  if (!settings.workspace) settings.workspace = { lastCwd: null, recentCwds: [] }
  if (typeof cwd !== 'string' || !cwd) return settings
  settings.workspace.lastCwd = cwd
  const rec = Array.isArray(settings.workspace.recentCwds) ? settings.workspace.recentCwds : []
  settings.workspace.recentCwds = [cwd, ...rec.filter((p) => p !== cwd)].slice(0, RECENT_CWD_CAP)
  return settings
}

function deepMerge(base, over) {
  if (over === null || over === undefined) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over
  const out = { ...base }
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k])
  return out
}

export function ensureDataRoot() {
  const root = dataRoot()
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'prompts'), { recursive: true })
  try { chmodSync(root, 0o700) } catch {}
  return root
}

export function loadSettings() {
  const file = join(dataRoot(), 'settings.yaml')
  if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS)
  let merged = null
  try {
    const raw = yaml.load(readFileSync(file, 'utf8')) || {}
    merged = deepMerge(structuredClone(DEFAULT_SETTINGS), raw)
  } catch (e) {
    let broken = null
    try { broken = `${file}.broken-${Date.now()}`; renameSync(file, broken) } catch { broken = null }
    logSink.warn(`[settings] settings.yaml 解析失败：${e.message}；已临时使用默认值${broken ? `，原文件备份为 ${broken}` : ''}`)
    const d = structuredClone(DEFAULT_SETTINGS)
    d.__loadFailed = e.message
    return d
  }
  return clampEnums(merged)
}

export function saveSettings(settings) {
  const root = ensureDataRoot()
  const file = join(root, 'settings.yaml')
  const tmp = file + '.tmp'
  const banner =
    '# Grok Build Desktop settings (safe to sync). Secrets live in .credentials.yaml (0600).\n'
  const { __loadFailed, ...clean } = settings
  writeFileSync(tmp, banner + yaml.dump(clean, { lineWidth: 120 }), 'utf8')
  renameSync(tmp, file)
  return settings
}

// 明文密钥固定放 userData：dev 模式 dataRoot 在 OneDrive 同步目录里，不能跟着上云。
// settings.yaml / prompts 仍留在 dataRoot。
function credentialsFile() {
  const file = join(app.getPath('userData'), '.credentials.yaml')
  const legacy = join(dataRoot(), '.credentials.yaml')
  if (legacy !== file && existsSync(legacy)) {
    try {
      // legacy 还在就以它为准：上次 unlink 失败期间的保存都落在 legacy，跳过覆盖会在
      // 这次 unlink 成功时把新钥匙删掉。仅当 userData 副本更新（OneDrive 复活旧文件）才不覆盖。
      if (!existsSync(file) || statSync(legacy).mtimeMs >= statSync(file).mtimeMs) {
        mkdirSync(dirname(file), { recursive: true })
        // 跨卷（CloudStorage）rename 会 EXDEV，用 copy+unlink
        copyFileSync(legacy, file)
        chmodSync(file, 0o600)
      }
      unlinkSync(legacy)
    } catch (e) {
      logSink.warn(`[settings] .credentials.yaml 迁移失败，仍用旧位置：${e.message}`)
      return legacy
    }
  }
  return file
}

export function loadCredentials({ strict = false } = {}) {
  const file = credentialsFile()
  if (!existsSync(file)) return {}
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if (strict) throw new Error(`.credentials.yaml 读取失败，为避免覆盖已有密钥已中止：${e.message}`)
    return {}
  }
  if (!text.trim()) return {}
  let raw
  try {
    raw = yaml.load(text)
  } catch (e) {
    if (strict) {
      throw new Error(`.credentials.yaml 解析失败，为避免覆盖已有密钥已中止；请先修复或删除该文件（${e.message}）`)
    }
    return {}
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (strict) throw new Error('.credentials.yaml 内容不是 KEY: value 键值表，为避免覆盖已有密钥已中止；请先修复或删除该文件')
  return {}
}

export function saveCredential(name, value) {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name)) throw new Error('密钥名必须是大写字母/数字/下划线')
  const v = String(value || '').trim()
  if (!v) throw new Error('密钥为空')
  if (v.includes('=') && /^[A-Z0-9_]+=/.test(v)) throw new Error('请只粘贴密钥值，不要带 NAME= 前缀')
  if (/^['"].*['"]$/.test(v)) throw new Error('请去掉包裹的引号')
  if ([...v].some((ch) => ch.charCodeAt(0) < 0x21 || ch.charCodeAt(0) > 0x7e)) {
    throw new Error('密钥含空格或不可见字符（HTTP 头无法携带）')
  }
  ensureDataRoot()
  const file = credentialsFile()
  const creds = loadCredentials({ strict: true })
  if (existsSync(file)) {
    try { copyFileSync(file, file + '.bak'); chmodSync(file + '.bak', 0o600) } catch {}
  }
  creds[name] = v
  const tmp = file + '.tmp'
  writeFileSync(tmp, yaml.dump(creds, { forceQuotes: true }), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  try { chmodSync(file, 0o600) } catch {}
  return true
}

export function credentialNames() {
  return Object.keys(loadCredentials())
}
