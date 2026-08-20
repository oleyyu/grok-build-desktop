// Session list / hard delete under ~/.grok/sessions/<encodeURIComponent(cwd)>/<uuid>/.
// Archive is permanent delete; SESSION_ID_RE is the path-traversal guard.

import { readdir, readFile, stat, rm, realpath } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { homedir } from 'node:os'

const SESSIONS_ROOT = join(homedir(), '.grok', 'sessions')
// UUID shape; blocks ../
const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/

/**
 * Hide subagent sessions (session_kind starts with subagent*). Sidebar and stats
 * must share this. User-initiated fork/worktree stays visible.
 */
export function isHiddenSession(dir, summary) {
  let s = summary
  if (s === undefined) {
    try { s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) } catch { return false }
  }
  if (!s || typeof s !== 'object') return false
  return String(s.session_kind || '').startsWith('subagent')
}

export async function listSessions() {
  let groups
  try {
    groups = await readdir(SESSIONS_ROOT, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const g of groups) {
    if (!g.isDirectory()) continue
    let cwd
    try { cwd = decodeURIComponent(g.name) } catch { continue }
    if (!cwd.startsWith('/')) continue
    const groupDir = join(SESSIONS_ROOT, g.name)
    let entries
    try { entries = await readdir(groupDir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || !SESSION_ID_RE.test(e.name)) continue
      const dir = join(groupDir, e.name)
      let title = null
      let updatedAt = 0
      let hidden = false
      try {
        const summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8'))
        hidden = isHiddenSession(dir, summary)
        title = summary.session_summary || null
      } catch {}
      if (hidden) continue
      try {
        const s = await stat(join(dir, 'chat_history.jsonl'))
        updatedAt = s.mtimeMs
      } catch {
        try { updatedAt = (await stat(dir)).mtimeMs } catch {}
      }
      out.push({ id: e.name, cwd, title, updatedAt })
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/** Permanent delete; id regex + realpath so symlinks cannot escape. */
export async function deleteSession({ id, cwd }) {
  if (!SESSION_ID_RE.test(id)) throw new Error('非法 session id')
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new Error('非法 cwd')
  const dir = join(SESSIONS_ROOT, encodeURIComponent(cwd), id)
  let real
  try { real = await realpath(dir) } catch { return { ok: true, missing: true } }
  const root = await realpath(SESSIONS_ROOT)
  if (real !== root && !real.startsWith(root + sep)) throw new Error('目标不在 sessions 根目录内，拒绝删除')
  await rm(real, { recursive: true, force: true })
  return { ok: true }
}
