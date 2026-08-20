// Prompt library: home/prompts/*.md; combine.txt stacks files (later = more weight).
// Applied as session/new _meta.systemPromptOverride. Only {{model}}/{{cwd}}; other {{}} skips the file.

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { dataRoot } from './settings.js'

const ALLOWED_VARS = new Set(['model', 'cwd'])
const RESERVED_IDS = new Set(['standard', 'code', 'minimal', 'cordis', 'stacked'])

function promptsDir() {
  return join(dataRoot(), 'prompts')
}

function slugify(stem) {
  // Keep CJK in ids; [a-z0-9]-only slugify would empty Chinese filenames.
  let id = stem.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-')
  if (!id) id = 'prompt'
  if (RESERVED_IDS.has(id)) id += '-my'
  return id
}

/** False if the file uses disallowed template vars. */
function validateVars(text) {
  if (text.includes('{{{')) return false
  for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    if (!ALLOWED_VARS.has(m[1])) return false
  }
  return true
}

function displayNameOf(text, stem) {
  const first = text.split('\n', 1)[0].trim()
  if (first.startsWith('# ')) return first.slice(2).trim() || stem
  return stem
}

/** List presets including stacked; UI gets metadata only. */
export function listPresets() {
  const dir = promptsDir()
  if (!existsSync(dir)) return []
  const presets = []
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  const validByName = new Map()
  const usedIds = new Set()

  for (const f of files) {
    const path = join(dir, f)
    let text
    try { text = readFileSync(path, 'utf8') } catch { continue }
    if (!text.trim()) continue
    if (!validateVars(text)) continue
    const stem = basename(f, '.md')
    let id = slugify(stem)
    while (usedIds.has(id)) {
      const m = id.match(/-(\d+)$/)
      id = m ? id.replace(/-\d+$/, `-${Number(m[1]) + 1}`) : `${id}-2`
    }
    usedIds.add(id)
    const preset = {
      id,
      name: displayNameOf(text, stem),
      description: f,
      order: stem === 'my-default' ? 1 : 10,
      files: [f],
    }
    presets.push(preset)
    validByName.set(f, preset)
  }

  // stacked preset needs ≥2 valid files in combine.txt
  const combinePath = join(dir, 'combine.txt')
  if (existsSync(combinePath)) {
    try {
      const lines = readFileSync(combinePath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
      const stackFiles = lines.filter((l) => validByName.has(l))
      if (stackFiles.length >= 2) {
        presets.push({
          id: 'stacked',
          // Fallback name; renderer prefers nameKey/nameArgs so EN UI is not stuck with Chinese.
          name: `${stackFiles.length} 份叠加`,
          nameKey: '{0} stacked',
          nameArgs: [stackFiles.length],
          description: stackFiles.join(' + '),
          order: 5,
          files: stackFiles,
        })
      }
    } catch {}
  }

  presets.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh'))
  return presets
}

/** Concatenate preset files and substitute {{model}}/{{cwd}}. */
export function resolvePresetText(presetId, { model = '', cwd = '' } = {}) {
  if (!presetId) return null
  const preset = listPresets().find((p) => p.id === presetId)
  if (!preset) return null
  const dir = promptsDir()
  const parts = []
  for (const f of preset.files) {
    try {
      const t = readFileSync(join(dir, f), 'utf8').trim()
      if (t) parts.push(t)
    } catch {}
  }
  if (!parts.length) return null
  // Same whitespace-tolerant regex as validateVars, else {{ model }} never substitutes.
  return parts.join('\n\n').replace(/\{\{\s*(model|cwd)\s*\}\}/g, (_, k) => (k === 'model' ? model : cwd))
}

/** First-run seed: README + combine.txt if missing. */
export function seedPromptsDir() {
  const dir = promptsDir()
  const readme = join(dir, 'README.txt')
  if (existsSync(readme)) return
  writeFileSync(readme, `prompts 目录 —— 提示词库（一个 .md = 一份提示词 = 一种模式）

规则（与你的 DSH 习惯一致）：
- 文件第一行写「# 标题」就是界面上显示的名字，不写就用文件名。
- 只允许两个模板变量：{{model}} 和 {{cwd}}，出现别的 {{xxx}} 该文件会被跳过。
- 空文件跳过；my-default.md 会排到第一位。
- combine.txt 里按顺序写文件名（一行一个，# 开头是注释），
  有效文件 ≥2 份时会出现一个「N 份叠加」预设：按顺序拼成一整份提示词，
  后写的在末尾，模型通常更听它。
- 预设通过 grok 的 systemPromptOverride 整体替换系统提示词；
  改完文件，下一个新会话生效（进行中的会话不变）。
`, 'utf8')
  if (!existsSync(join(dir, 'combine.txt'))) {
    writeFileSync(join(dir, 'combine.txt'), '# 一行一个文件名，≥2 份有效文件时生成「叠加」预设\n', 'utf8')
  }
}
