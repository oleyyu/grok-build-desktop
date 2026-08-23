// Usage stats from ~/.grok/sessions. Cached 30s.
//   events.jsonl  -> turn_started (dates, models, streaks)
//   signals.json  -> message counts; contextTokensUsed is only a fallback
//   updates.jsonl -> turn_completed.usage.totalTokens (billed tokens: heatmap, lifetime, peak)

import { readdirSync, readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isHiddenSession } from './sessions-store.js'

const SESSIONS_ROOT = join(homedir(), '.grok', 'sessions')
const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/
const HP1_TOKENS = 103000 // ~HP1 token count (Claude's fun conversion)

let cache = { at: 0, data: null }
export function invalidateStats() { cache = { at: 0, data: null } }

function localDay(d) {
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Previous local calendar day (DST-safe). Do not parse YYYY-MM-DD as UTC then
// format local — UTC+12+ yields the same day and the streak loop hangs the main process.
function prevLocalDay(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number)
  return localDay(new Date(y, m - 1, d - 1, 12))
}

// Chunked line scan: events.jsonl can be tens of MB; full readFileSync stalls main.
// StringDecoder handles UTF-8 split across chunks.
function forEachLine(path, onLine) {
  let fd
  try { fd = openSync(path, 'r') } catch { return }
  const dec = new StringDecoder('utf8')
  const buf = Buffer.allocUnsafe(65536)
  let carry = ''
  try {
    for (;;) {
      let n = 0
      try { n = readSync(fd, buf, 0, buf.length, null) } catch { break }
      if (n <= 0) break
      carry += dec.write(buf.subarray(0, n))
      let idx = 0
      for (;;) {
        const nl = carry.indexOf('\n', idx)
        if (nl === -1) break
        onLine(carry.slice(idx, nl))
        idx = nl + 1
      }
      carry = carry.slice(idx)
    }
    carry += dec.end()
    if (carry) onLine(carry)
  } finally {
    try { closeSync(fd) } catch {}
  }
}

function usageDate(ev) {
  const ms = ev.params?._meta?.agentTimestampMs
  if (typeof ms === 'number' && Number.isFinite(ms)) return new Date(ms)
  const ts = ev.timestamp
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts > 1e12 ? ts : ts * 1000)
  if (typeof ts === 'string') {
    const d = new Date(ts)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

function addTokensFromUpdates(sdir, tokenByDay) {
  const updPath = join(sdir, 'updates.jsonl')
  if (!existsSync(updPath)) return 0
  const seen = new Set()
  let billed = 0
  forEachLine(updPath, (line) => {
    if (!line.includes('"turn_completed"') || !line.includes('"usage"')) return
    try {
      const ev = JSON.parse(line)
      const u = ev.params?.update
      if (u?.sessionUpdate !== 'turn_completed') return
      const tokens = u.usage?.totalTokens
      if (!(tokens > 0)) return
      const pid = u.prompt_id
      if (pid) {
        if (seen.has(pid)) return
        seen.add(pid)
      }
      const d = usageDate(ev)
      if (!d || Number.isNaN(d.getTime())) return
      const day = localDay(d)
      tokenByDay.set(day, (tokenByDay.get(day) || 0) + tokens)
      billed += tokens
    } catch {}
  })
  return billed
}

function sumTokensSince(tokenByDay, sinceDay) {
  let n = 0
  for (const [day, tokens] of tokenByDay) {
    if (sinceDay == null || day >= sinceDay) n += tokens
  }
  return n
}

function scan() {
  const turns = [] // {ts: Date, model, sessionKey}
  const sessions = [] // {key, messages, tokens, model, days:Set, hasSignals}
  const tokenByDay = new Map()
  let groups = []
  try { groups = readdirSync(SESSIONS_ROOT, { withFileTypes: true }) } catch { return { turns, sessions, tokenByDay } }

  for (const g of groups) {
    if (!g.isDirectory()) continue
    const gdir = join(SESSIONS_ROOT, g.name)
    let entries = []
    try { entries = readdirSync(gdir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || !SESSION_ID_RE.test(e.name)) continue
      const sdir = join(gdir, e.name)
      // Subagents stay off the session list / streak tiles, but their billed
      // tokens still belong on the Token activity heatmap and lifetime total.
      if (isHiddenSession(sdir)) {
        addTokensFromUpdates(sdir, tokenByDay)
        continue
      }
      const sess = { key: e.name, messages: 0, tokens: 0, billed: 0, model: null, days: new Set(), turnCount: 0, hasSignals: false }

      const sigPath = join(sdir, 'signals.json')
      if (existsSync(sigPath)) {
        try {
          const sig = JSON.parse(readFileSync(sigPath, 'utf8'))
          sess.messages = (sig.userMessageCount || 0) + (sig.assistantMessageCount || 0)
          sess.tokens = sig.contextTokensUsed || 0
          sess.model = sig.primaryModelId || null
          sess.hasSignals = true
        } catch {}
      }

      const evPath = join(sdir, 'events.jsonl')
      if (existsSync(evPath)) {
        // Parse only turn_started lines.
        forEachLine(evPath, (line) => {
          if (!line.includes('"turn_started"')) return
          try {
            const ev = JSON.parse(line)
            if (ev.type !== 'turn_started' || !ev.ts) return
            const d = new Date(ev.ts)
            if (Number.isNaN(d.getTime())) return
            const model = ev.model_id || sess.model
            turns.push({ ts: d, model, sessionKey: sess.key })
            sess.turnCount++
            sess.days.add(localDay(d))
          } catch {}
        })
      }

      const billed = addTokensFromUpdates(sdir, tokenByDay)
      sess.billed = billed
      // contextTokensUsed is the live window, not spend — only a fallback for
      // older sessions that never wrote turn_completed usage.
      if (billed > 0) sess.tokens = billed
      if (!sess.hasSignals) sess.messages = sess.turnCount * 2 // old sessions: 1 user + 1 assistant per turn
      sessions.push(sess)
    }
  }
  return { turns, sessions, tokenByDay }
}

function tilesFor(turns, sessions, sinceMs) {
  const inRange = (d) => sinceMs == null || d.getTime() >= sinceMs
  const rTurns = turns.filter((t) => inRange(t.ts))
  const activeKeys = new Set(rTurns.map((t) => t.sessionKey))
  const rSessions = sessions.filter((s) => (sinceMs == null ? true : activeKeys.has(s.key)))

  const days = new Set()
  const hourCount = new Map()
  const modelCount = new Map()
  for (const t of rTurns) {
    days.add(localDay(t.ts))
    const h = t.ts.getHours()
    hourCount.set(h, (hourCount.get(h) || 0) + 1)
    if (t.model) modelCount.set(t.model, (modelCount.get(t.model) || 0) + 1)
  }

  // Streak: consecutive active days ending today or yesterday.
  const sorted = [...days].sort()
  let longest = 0, run = 0, prev = null
  for (const day of sorted) {
    if (prev != null) {
      const diff = (new Date(day) - new Date(prev)) / 86400000
      run = diff === 1 ? run + 1 : 1
    } else run = 1
    longest = Math.max(longest, run)
    prev = day
  }
  const today = localDay(new Date())
  const yesterday = prevLocalDay(today)
  let current = 0
  let cursor = days.has(today) ? today : (days.has(yesterday) ? yesterday : null)
  while (cursor && days.has(cursor)) {
    current++
    cursor = prevLocalDay(cursor)
  }

  let peakHour = null, peakN = 0
  for (const [h, n] of hourCount) if (n > peakN) { peakN = n; peakHour = h }
  let favModel = null, favN = 0
  for (const [m, n] of modelCount) if (n > favN) { favN = n; favModel = m }

  return {
    sessions: rSessions.length,
    turns: rTurns.length,
    // messages are lifetime per session — accurate only for "all".
    // tokens are filled in getStats() from billed turn_completed usage.
    messages: rSessions.reduce((a, s) => a + s.messages, 0),
    tokens: 0,
    activeDays: days.size,
    currentStreak: current,
    longestStreak: longest,
    peakHour,
    favoriteModel: favModel,
  }
}

export function getStats() {
  if (cache.data && Date.now() - cache.at < 30000) return cache.data
  const { turns, sessions, tokenByDay } = scan()
  const now = Date.now()

  // Heatmap: last 20 weeks of daily turn counts + billed tokens.
  const dayCount = new Map()
  for (const t of turns) {
    const day = localDay(t.ts)
    dayCount.set(day, (dayCount.get(day) || 0) + 1)
  }
  const heatmap = []
  const todayD = new Date(); todayD.setHours(12, 0, 0, 0)
  const start = new Date(todayD.getTime() - 139 * 86400000)
  for (let i = 0; i < 140; i++) {
    const d = new Date(start.getTime() + i * 86400000)
    const day = localDay(d)
    heatmap.push({ date: day, count: dayCount.get(day) || 0, tokens: tokenByDay.get(day) || 0 })
  }

  // Account-page year heatmap (364 days); renderer aligns to Monday.
  const heatmapYear = []
  const yearStart = new Date(todayD.getTime() - 363 * 86400000)
  for (let i = 0; i < 364; i++) {
    const d = new Date(yearStart.getTime() + i * 86400000)
    const day = localDay(d)
    heatmapYear.push({ date: day, count: dayCount.get(day) || 0, tokens: tokenByDay.get(day) || 0 })
  }

  // Peak billed tokens in one visible session + longest span between first and last turn.
  let peakSessionTokens = 0
  for (const s of sessions) peakSessionTokens = Math.max(peakSessionTokens, s.tokens || 0)
  const span = new Map()
  for (const t of turns) {
    const cur = span.get(t.sessionKey)
    if (!cur) span.set(t.sessionKey, { min: t.ts.getTime(), max: t.ts.getTime() })
    else {
      if (t.ts.getTime() < cur.min) cur.min = t.ts.getTime()
      if (t.ts.getTime() > cur.max) cur.max = t.ts.getTime()
    }
  }
  let longestChatMs = 0
  for (const v of span.values()) longestChatMs = Math.max(longestChatMs, v.max - v.min)

  // Lifetime = billed tokens (heatmap source, including hidden subagents) plus
  // contextTokensUsed only for sessions that never recorded turn usage.
  const billedAll = sumTokensSince(tokenByDay, null)
  const fallback = sessions.reduce((a, s) => a + (s.billed > 0 ? 0 : (s.tokens || 0)), 0)
  const all = tilesFor(turns, sessions, null)
  all.tokens = billedAll + fallback
  const d30 = tilesFor(turns, sessions, now - 30 * 86400000)
  d30.tokens = sumTokensSince(tokenByDay, localDay(new Date(now - 30 * 86400000)))
  const d7 = tilesFor(turns, sessions, now - 7 * 86400000)
  d7.tokens = sumTokensSince(tokenByDay, localDay(new Date(now - 7 * 86400000)))
  const data = {
    generatedAt: now,
    ranges: {
      all,
      d30,
      d7,
    },
    heatmap,
    heatmapYear,
    peakSessionTokens,
    longestChatMs,
    funMultiple: all.tokens > 0 ? Math.round(all.tokens / HP1_TOKENS) : 0,
  }
  cache = { at: now, data }
  return data
}
