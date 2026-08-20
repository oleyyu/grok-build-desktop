
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, renameSync, copyFileSync } from 'node:fs'
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
  },
  engine: {
    model: null,
    effort: null,
    permissionMode: 'ask',      // ask | auto-safe | always-approve
    computerUse: false,
  },
  workspace: {
    lastCwd: null,
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
  fix(s.engine, 'permissionMode', PERMISSION_MODES, 'ask')
  fix(s.engine, 'effort', EFFORTS, null, true)
  return s
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

export function loadCredentials({ strict = false } = {}) {
  const file = join(dataRoot(), '.credentials.yaml')
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
  const root = ensureDataRoot()
  const file = join(root, '.credentials.yaml')
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
