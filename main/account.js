// Account pool: multiple grok identities, one active in ~/.grok/auth.json.
// Tokens never leave main. Renderer only sees identity + usage snapshots.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync,
  rmSync, mkdtempSync, watch, unlinkSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { app } from 'electron'
import { AcpClient } from './acp-client.js'

export const AUTH_FILE = join(homedir(), '.grok', 'auth.json')
export const GROK_BIN = join(homedir(), '.grok', 'bin', 'grok')

function grokBin() {
  const candidates = [GROK_BIN, '/usr/local/bin/grok', '/opt/homebrew/bin/grok']
  for (const c of candidates) if (existsSync(c)) return c
  return GROK_BIN
}

const POOL_VERSION = 1
const MAX_ACCOUNTS = 8
const USAGE_STALE_MS = 5 * 60e3
const EXHAUSTED_PCT = 99.5
const AUTH_WATCH_DEBOUNCE_MS = 400

let logSink = { info: () => {}, warn: (m) => console.warn(m) }
export function setAccountLogger(l) {
  if (l && typeof l.info === 'function') logSink = l
}

function poolFile() {
  return join(app.getPath('userData'), '.accounts.json')
}

function emptyPool() {
  return { version: POOL_VERSION, activeId: null, accounts: {} }
}

function atomicWrite(file, text, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  renameSync(tmp, file)
  try { chmodSync(file, mode) } catch {}
}

function readJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function readAuthFile() {
  const raw = readJson(AUTH_FILE)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw
}

let ignoreAuthWatchUntil = 0
function writeAuthFile(raw) {
  ignoreAuthWatchUntil = Date.now() + 800
  if (!raw) {
    try { unlinkSync(AUTH_FILE) } catch {}
    return
  }
  mkdirSync(dirname(AUTH_FILE), { recursive: true })
  atomicWrite(AUTH_FILE, JSON.stringify(raw, null, 2), 0o600)
}

function loadPool() {
  const raw = readJson(poolFile())
  if (!raw || typeof raw !== 'object' || raw.version !== POOL_VERSION) return emptyPool()
  if (!raw.accounts || typeof raw.accounts !== 'object') return emptyPool()
  return {
    version: POOL_VERSION,
    activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
    accounts: raw.accounts,
  }
}

function savePool(pool) {
  atomicWrite(poolFile(), JSON.stringify(pool), 0o600)
}

function nameOf(v) {
  return [v?.first_name, v?.last_name].filter(Boolean).join(' ') || null
}

/** First email-bearing slot in an auth.json blob. */
export function identityFromAuth(raw) {
  if (!raw || typeof raw !== 'object') return null
  for (const [key, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || !v.email) continue
    const userId = v.user_id || v.principal_id || null
    const id = userId || String(v.email)
    return {
      id,
      email: v.email,
      name: nameOf(v),
      userId,
      teamId: v.team_id || null,
      authMode: v.auth_mode || null,
      issuer: v.oidc_issuer || key.split('::')[0] || null,
      createTime: v.create_time || null,
      expiresAt: v.expires_at || null,
      retentionOptOut: v.coding_data_retention_opt_out === true,
    }
  }
  return null
}

function publicFromEntry(a, activeId) {
  return {
    id: a.id,
    email: a.email,
    name: a.name || null,
    userId: a.userId || null,
    teamId: a.teamId || null,
    authMode: a.authMode || null,
    issuer: a.issuer || null,
    createTime: a.createTime || null,
    expiresAt: a.expiresAt || null,
    retentionOptOut: a.retentionOptOut === true,
    active: a.id === activeId,
    percent: a.usage?.percent ?? null,
    used: a.usage?.used ?? null,
    limit: a.usage?.limit ?? null,
    periodEnd: a.usage?.periodEnd ?? null,
    periodType: a.usage?.periodType ?? null,
    tier: a.usage?.tier ?? null,
    usageAt: a.usage?.fetchedAt ?? null,
    exhausted: !!a.exhausted,
  }
}

function upsertAuthIntoPool(pool, raw) {
  const ident = identityFromAuth(raw)
  if (!ident) return null
  const ids = Object.keys(pool.accounts)
  if (!pool.accounts[ident.id] && ids.length >= MAX_ACCOUNTS) {
    throw new Error(`最多接入 ${MAX_ACCOUNTS} 个 Grok 账号`)
  }
  const prev = pool.accounts[ident.id] || {}
  pool.accounts[ident.id] = {
    ...prev,
    ...ident,
    auth: raw,
    usage: prev.usage || null,
    exhausted: prev.exhausted === true,
    exhaustedAt: prev.exhaustedAt || null,
  }
  pool.activeId = ident.id
  return ident
}

/** Pull ~/.grok/auth.json into the pool (login, token refresh, TUI login). */
export function ingestAuthFile() {
  const raw = readAuthFile()
  if (!raw) return null
  const pool = loadPool()
  const ident = upsertAuthIntoPool(pool, raw)
  if (!ident) return null
  savePool(pool)
  return ident
}

/** If auth.json is empty but the pool still has an active account, restore it. */
export function hydratePool() {
  const pool = loadPool()
  const raw = readAuthFile()
  const disk = identityFromAuth(raw)
  if (disk && raw) {
    try {
      upsertAuthIntoPool(pool, raw)
      savePool(pool)
    } catch (e) {
      logSink.warn(`[account] hydrate upsert failed: ${e.message}`)
    }
    return getAccount()
  }
  if (pool.activeId && pool.accounts[pool.activeId]?.auth) {
    writeAuthFile(pool.accounts[pool.activeId].auth)
    return getAccount()
  }
  const first = Object.values(pool.accounts)[0]
  if (first?.auth) {
    pool.activeId = first.id
    savePool(pool)
    writeAuthFile(first.auth)
    return getAccount()
  }
  return getAccount()
}

/** Identity-only view. Tokens stay in the pool file / auth.json. */
export function getAccount() {
  const raw = readAuthFile()
  const disk = identityFromAuth(raw)
  const pool = loadPool()
  if (disk && raw && pool.activeId !== disk.id) {
    try {
      upsertAuthIntoPool(pool, raw)
      savePool(pool)
    } catch { /* cap: leave disk as-is, still report it */ }
  }
  const active = disk || (pool.activeId && pool.accounts[pool.activeId]
    ? publicFromEntry(pool.accounts[pool.activeId], pool.activeId)
    : null)
  const accounts = Object.values(pool.accounts).map((a) => publicFromEntry(a, pool.activeId || disk?.id))
  if (disk && !accounts.some((a) => a.id === disk.id)) {
    accounts.unshift({ ...disk, active: true, percent: null, exhausted: false, tier: null })
  }
  if (!active) return { loggedIn: false, accounts }
  return {
    loggedIn: true,
    email: active.email,
    name: active.name || null,
    userId: active.userId || null,
    teamId: active.teamId || null,
    authMode: active.authMode || null,
    issuer: active.issuer || null,
    createTime: active.createTime || null,
    expiresAt: active.expiresAt || null,
    retentionOptOut: active.retentionOptOut === true,
    activeId: pool.activeId || disk?.id || null,
    accounts,
  }
}

export function accountCount() {
  return Object.keys(loadPool().accounts).length
}

/** Capture grok's in-place token refresh into the active pool entry. */
export function syncActiveFromDisk() {
  const raw = readAuthFile()
  const ident = identityFromAuth(raw)
  if (!ident || !raw) return null
  const pool = loadPool()
  const cur = pool.accounts[ident.id] || pool.accounts[pool.activeId]
  if (cur && cur.id === ident.id) {
    cur.auth = raw
    Object.assign(cur, ident)
    pool.activeId = ident.id
    savePool(pool)
    return ident
  }
  try {
    upsertAuthIntoPool(pool, raw)
    savePool(pool)
  } catch (e) {
    logSink.warn(`[account] sync upsert failed: ${e.message}`)
  }
  return ident
}

export function activateAccount(id) {
  if (typeof id !== 'string' || !id) throw new Error('缺少账号 id')
  syncActiveFromDisk()
  const pool = loadPool()
  const a = pool.accounts[id]
  if (!a?.auth) throw new Error('账号不在本地池里，请重新登录')
  writeAuthFile(a.auth)
  pool.activeId = id
  savePool(pool)
  return publicFromEntry(a, id)
}

export function pickNextAccount() {
  const pool = loadPool()
  const ids = Object.keys(pool.accounts)
  if (ids.length < 2) return null
  const active = pool.activeId
  const start = Math.max(0, ids.indexOf(active))
  const now = Date.now()
  const usable = (a) => {
    if (!a?.auth) return false
    if (a.usage?.periodEnd) {
      const end = Date.parse(a.usage.periodEnd)
      if (Number.isFinite(end) && end <= now) {
        a.exhausted = false
        a.exhaustedAt = null
      }
    }
    if (a.exhausted) return false
    if (typeof a.usage?.percent === 'number' && a.usage.percent >= EXHAUSTED_PCT) return false
    return true
  }
  for (let i = 1; i < ids.length; i++) {
    const id = ids[(start + i) % ids.length]
    if (id === active) continue
    if (usable(pool.accounts[id])) return publicFromEntry(pool.accounts[id], pool.activeId)
  }
  return null
}

export function removeAccount(id) {
  if (typeof id !== 'string' || !id) throw new Error('缺少账号 id')
  syncActiveFromDisk()
  const pool = loadPool()
  if (!pool.accounts[id]) throw new Error('账号不在本地池里')
  const wasActive = pool.activeId === id
  delete pool.accounts[id]
  if (wasActive) {
    const next = Object.values(pool.accounts)[0] || null
    pool.activeId = next?.id || null
    savePool(pool)
    if (next?.auth) writeAuthFile(next.auth)
    else writeAuthFile(null)
    return { removed: id, active: next ? publicFromEntry(next, next.id) : null, emptied: !next }
  }
  savePool(pool)
  return { removed: id, active: pool.activeId ? publicFromEntry(pool.accounts[pool.activeId], pool.activeId) : null, emptied: false }
}

export function clearPool() {
  savePool(emptyPool())
}

export function usageFraction(b) {
  const cfg = b?.config || {}
  if (cfg.used?.val != null && cfg.monthlyLimit?.val > 0) return cfg.used.val / cfg.monthlyLimit.val
  const p = cfg.creditUsagePercent
  if (typeof p === 'number' && Number.isFinite(p)) return Math.max(0, p / 100)
  return null
}

export function isBillingExhausted(b) {
  const f = usageFraction(b)
  return f != null && f >= EXHAUSTED_PCT / 100
}

export function isUsageLimitError(err) {
  const msg = String(err?.message || err || '')
  const code = String(err?.code || err?.data?.error_type || err?.data?.type || '')
  const blob = `${msg}\n${code}`.toLowerCase()
  return /credit limit|usage limit|usage_pool_exhausted|usage_limit_reached|spending cap|hit the rate limit for your plan|you've hit the credit|you’ve hit the credit|free grok build usage limit/.test(blob)
}

export function recordUsage(id, billing) {
  if (!id || !billing) return
  const pool = loadPool()
  const a = pool.accounts[id]
  if (!a) return
  const cfg = billing.config || {}
  const frac = usageFraction(billing)
  const percent = frac != null ? frac * 100 : (typeof cfg.creditUsagePercent === 'number' ? cfg.creditUsagePercent : null)
  const period = cfg.currentPeriod || {}
  a.usage = {
    percent,
    used: cfg.used?.val ?? null,
    limit: cfg.monthlyLimit?.val ?? null,
    periodEnd: period.end || cfg.billingPeriodEnd || null,
    periodType: period.type || null,
    tier: billing.subscription_tier || billing.subscriptionTier || null,
    fetchedAt: Date.now(),
    onDemandCap: cfg.onDemandCap?.val ?? null,
    onDemandUsed: cfg.onDemandUsed?.val ?? null,
    prepaid: cfg.prepaidBalance?.val ?? null,
    onDemandEnabled: !!(billing.on_demand_enabled ?? billing.onDemandEnabled),
  }
  a.exhausted = percent != null && percent >= EXHAUSTED_PCT
  a.exhaustedAt = a.exhausted ? Date.now() : null
  savePool(pool)
}

function snapshotToBilling(u) {
  if (!u) return null
  return {
    config: {
      creditUsagePercent: u.percent,
      currentPeriod: { type: u.periodType || '', end: u.periodEnd || null },
      used: u.used != null ? { val: u.used } : undefined,
      monthlyLimit: u.limit != null ? { val: u.limit } : undefined,
      onDemandCap: { val: u.onDemandCap || 0 },
      onDemandUsed: { val: u.onDemandUsed || 0 },
      prepaidBalance: { val: u.prepaid || 0 },
      billingPeriodEnd: u.periodEnd || null,
    },
    onDemandEnabled: !!u.onDemandEnabled,
    on_demand_enabled: !!u.onDemandEnabled,
    subscription_tier: u.tier || null,
    subscriptionTier: u.tier || null,
  }
}

function accountUsageRow(a, billing, activeId) {
  const cfg = billing?.config || {}
  const frac = usageFraction(billing)
  return {
    id: a.id,
    email: a.email,
    name: a.name || null,
    active: a.id === activeId,
    percent: frac != null ? frac * 100 : (a.usage?.percent ?? null),
    tier: billing?.subscription_tier || billing?.subscriptionTier || a.usage?.tier || null,
    exhausted: frac != null ? frac >= EXHAUSTED_PCT / 100 : !!a.exhausted,
    periodEnd: cfg.currentPeriod?.end || cfg.billingPeriodEnd || a.usage?.periodEnd || null,
    periodType: cfg.currentPeriod?.type || a.usage?.periodType || null,
    stale: !billing || (a.usage?.fetchedAt && Date.now() - a.usage.fetchedAt > USAGE_STALE_MS),
  }
}

export function mergePoolBilling(live, liveId) {
  const pool = loadPool()
  const items = []
  for (const a of Object.values(pool.accounts)) {
    if (a.id === liveId && live) items.push({ a, billing: live })
    else if (a.usage) items.push({ a, billing: snapshotToBilling(a.usage) })
  }
  if (!items.length && live) {
    return { ...live, _merged: false, _mergedCount: 1, _accounts: [] }
  }
  const rows = items.map(({ a, billing }) => accountUsageRow(a, billing, pool.activeId))
  if (items.length <= 1) {
    const b = items[0]?.billing || live
    return { ...(b || {}), _merged: false, _mergedCount: items.length, _accounts: rows }
  }

  const fracs = items.map(({ billing }) => usageFraction(billing)).filter((x) => x != null)
  const abs = items.map(({ billing }) => {
    const cfg = billing?.config || {}
    if (cfg.used?.val != null && cfg.monthlyLimit?.val > 0) {
      return { used: cfg.used.val, limit: cfg.monthlyLimit.val }
    }
    return null
  })
  const allAbs = abs.length === items.length && abs.every(Boolean)
  let pct = 0
  let usedVal = null
  let limitVal = null
  if (allAbs) {
    usedVal = abs.reduce((s, x) => s + x.used, 0)
    limitVal = abs.reduce((s, x) => s + x.limit, 0)
    pct = limitVal > 0 ? (usedVal / limitVal) * 100 : 0
  } else if (fracs.length) {
    // Equal-weight merge: two SuperGrok weeklies at 80% + 20% → 50% of the combined pool.
    pct = (fracs.reduce((s, x) => s + x, 0) / fracs.length) * 100
  }

  const periods = items.map(({ billing }) => billing?.config?.currentPeriod || {})
  const types = [...new Set(periods.map((p) => p.type).filter(Boolean))]
  const ends = items
    .map(({ billing }) => billing?.config?.currentPeriod?.end || billing?.config?.billingPeriodEnd)
    .filter(Boolean)
    .sort()
  const starts = items
    .map(({ billing }) => billing?.config?.currentPeriod?.start || billing?.config?.billingPeriodStart)
    .filter(Boolean)
    .sort()
  const tiers = [...new Set(items.map(({ billing, a }) =>
    billing?.subscription_tier || billing?.subscriptionTier || a.usage?.tier).filter(Boolean))]
  const tierLabel = tiers.length <= 1
    ? (tiers[0] ? `${tiers[0]} · ${items.length}` : null)
    : tiers.join(' + ')

  const odCap = items.reduce((s, { billing }) => s + (billing?.config?.onDemandCap?.val || 0), 0)
  const odUsed = items.reduce((s, { billing }) => s + (billing?.config?.onDemandUsed?.val || 0), 0)
  const prepaid = items.reduce((s, { billing }) => s + (billing?.config?.prepaidBalance?.val || 0), 0)
  const odEnabled = items.some(({ billing }) => billing?.on_demand_enabled ?? billing?.onDemandEnabled)

  return {
    config: {
      creditUsagePercent: pct,
      currentPeriod: {
        type: types.length === 1 ? types[0] : (types[0] || ''),
        start: starts[0] || null,
        end: ends[0] || null,
      },
      used: usedVal != null ? { val: usedVal } : undefined,
      monthlyLimit: limitVal != null ? { val: limitVal } : undefined,
      onDemandCap: { val: odCap },
      onDemandUsed: { val: odUsed },
      prepaidBalance: { val: prepaid },
      isUnifiedBillingUser: items.some(({ billing }) => billing?.config?.isUnifiedBillingUser),
      billingPeriodStart: starts[0] || null,
      billingPeriodEnd: ends[0] || null,
    },
    onDemandEnabled: odEnabled,
    on_demand_enabled: odEnabled,
    subscription_tier: tierLabel,
    subscriptionTier: tierLabel,
    _merged: true,
    _mergedCount: items.length,
    _accounts: rows,
  }
}

/** Short-lived grok agent under a temp GROK_HOME so we can read another account's billing. */
export async function probeBilling(authObj, { timeoutMs = 20000 } = {}) {
  if (!authObj) throw new Error('没有可查询的凭证')
  const bin = grokBin()
  if (!existsSync(bin)) throw new Error('找不到 grok 可执行文件')
  const tmp = mkdtempSync(join(tmpdir(), 'gbd-acct-'))
  try {
    try { chmodSync(tmp, 0o700) } catch {}
    const authPath = join(tmp, 'auth.json')
    writeFileSync(authPath, JSON.stringify(authObj), { encoding: 'utf8', mode: 0o600 })
    const client = new AcpClient({
      binPath: bin,
      args: ['agent', '--no-leader', 'stdio'],
      env: { ...process.env, GROK_HOME: tmp },
      log: (m) => logSink.info(`[acct-probe] ${m}`),
    })
    client.start()
    try {
      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      }, { timeoutMs })
      let billing
      try {
        billing = await client.request('_x.ai/billing', {}, { timeoutMs: Math.min(15000, timeoutMs) })
      } catch (err) {
        if (!/method not found/i.test(err.message)) throw err
        billing = await client.request('x.ai/billing', {}, { timeoutMs: Math.min(15000, timeoutMs) })
      }
      let refreshed = null
      try { refreshed = JSON.parse(readFileSync(authPath, 'utf8')) } catch {}
      return { billing, auth: refreshed }
    } finally {
      await client.stop({ graceMs: 800 }).catch(() => {})
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export async function refreshInactiveUsage({ liveId, log } = {}) {
  const pool = loadPool()
  const now = Date.now()
  let changed = false
  for (const a of Object.values(pool.accounts)) {
    if (liveId && a.id === liveId) continue
    if (a.usage && now - a.usage.fetchedAt < USAGE_STALE_MS) continue
    if (!a.auth) continue
    try {
      const { billing, auth } = await probeBilling(a.auth)
      if (auth && typeof auth === 'object') a.auth = auth
      const cfg = billing?.config || {}
      const frac = usageFraction(billing)
      const percent = frac != null ? frac * 100 : (typeof cfg.creditUsagePercent === 'number' ? cfg.creditUsagePercent : null)
      const period = cfg.currentPeriod || {}
      a.usage = {
        percent,
        used: cfg.used?.val ?? null,
        limit: cfg.monthlyLimit?.val ?? null,
        periodEnd: period.end || cfg.billingPeriodEnd || null,
        periodType: period.type || null,
        tier: billing.subscription_tier || billing.subscriptionTier || null,
        fetchedAt: Date.now(),
        onDemandCap: cfg.onDemandCap?.val ?? null,
        onDemandUsed: cfg.onDemandUsed?.val ?? null,
        prepaid: cfg.prepaidBalance?.val ?? null,
        onDemandEnabled: !!(billing.on_demand_enabled ?? billing.onDemandEnabled),
      }
      a.exhausted = percent != null && percent >= EXHAUSTED_PCT
      a.exhaustedAt = a.exhausted ? Date.now() : null
      changed = true
    } catch (e) {
      ;(log || logSink).warn?.(`[account] probe ${a.email}: ${e.message}`)
    }
  }
  if (changed) savePool(pool)
  return pool
}

let authWatcher = null
let authWatchTimer = null
export function startAuthWatch() {
  stopAuthWatch()
  const dir = dirname(AUTH_FILE)
  try {
    authWatcher = watch(dir, (event, filename) => {
      if (filename && filename !== 'auth.json') return
      if (Date.now() < ignoreAuthWatchUntil) return
      clearTimeout(authWatchTimer)
      authWatchTimer = setTimeout(() => {
        try { syncActiveFromDisk() } catch (e) {
          logSink.warn(`[account] auth watch sync: ${e.message}`)
        }
      }, AUTH_WATCH_DEBOUNCE_MS)
    })
    authWatcher.on?.('error', () => {})
  } catch (e) {
    logSink.warn(`[account] auth.json watch failed: ${e.message}`)
  }
}

export function stopAuthWatch() {
  clearTimeout(authWatchTimer)
  authWatchTimer = null
  if (authWatcher) {
    try { authWatcher.close() } catch {}
    authWatcher = null
  }
}

let loginChild = null
let loginUrl = null
let loginPending = null
let loginDoneCbs = []
let loginBackupAuth = null

/**
 * Spawn `grok login --oauth` (no TTY). Resolves with the auth URL; CLI hosts
 * the 127.0.0.1 callback. Do not kill an in-flight child — that tears down
 * the callback server and the already-open browser page gets connection refused.
 * Only { force: true } cancels and restarts.
 *
 * Snapshots the current auth.json first so a failed / cancelled add-account
 * can restore the previous identity.
 */
export function grokLoginStart({ onDone, force = false } = {}) {
  if (loginChild && !force) {
    if (onDone) { loginDoneCbs.length = 0; loginDoneCbs.push(onDone) }
    if (loginUrl) return Promise.resolve({ url: loginUrl })
    if (loginPending) return loginPending
  }
  if (force) grokLoginCancel()
  try { ingestAuthFile() } catch (e) {
    logSink.warn(`[account] snapshot before login: ${e.message}`)
  }
  loginBackupAuth = readAuthFile()
  const cbs = onDone ? [onDone] : []
  loginDoneCbs = cbs
  const fireDone = (ok) => {
    if (ok) {
      try { ingestAuthFile() } catch (e) {
        logSink.warn(`[account] ingest after login: ${e.message}`)
      }
    } else if (loginBackupAuth) {
      try { writeAuthFile(loginBackupAuth) } catch (e) {
        logSink.warn(`[account] restore auth after failed login: ${e.message}`)
      }
    }
    loginBackupAuth = null
    for (const f of cbs.splice(0)) { try { f(ok) } catch { /* onDone threw */ } }
  }
  const p = new Promise((resolve, reject) => {
    const child = spawn(GROK_BIN, ['login', '--oauth'], { stdio: ['ignore', 'pipe', 'pipe'] })
    loginChild = child
    loginUrl = null
    let buf = ''
    let urlFound = false
    const feed = (chunk) => {
      if (urlFound) return
      buf += String(chunk)
      const m = buf.replace(/\x1b\[[0-9;]*m/g, '').match(/https:\/\/\S+/)
      if (m) {
        urlFound = true
        clearTimeout(urlTimer)
        if (loginChild === child) loginUrl = m[0]
        resolve({ url: m[0] })
      }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    const urlTimer = setTimeout(() => {
      if (!urlFound) { grokLoginCancel(); reject(new Error('grok login 10 秒内没有给出授权 URL')) }
    }, 10_000)
    const hardTimer = setTimeout(() => { if (loginChild === child) grokLoginCancel() }, 10 * 60_000)
    child.on('exit', (code) => {
      clearTimeout(urlTimer)
      clearTimeout(hardTimer)
      const isCurrent = loginChild === child
      if (isCurrent) { loginChild = null; loginUrl = null; loginPending = null }
      if (!urlFound) { reject(new Error(`grok login 提前退出（code ${code}）：${buf.slice(0, 300)}`)); return }
      fireDone(isCurrent && code === 0)
    })
    child.on('error', (err) => {
      clearTimeout(urlTimer)
      clearTimeout(hardTimer)
      if (loginChild === child) { loginChild = null; loginUrl = null; loginPending = null }
      if (!urlFound) reject(err)
      else fireDone(false)
    })
  })
  loginPending = p
  return p
}

/** Kill in-flight login (explicit re-login or app quit). */
export function grokLoginCancel() {
  if (loginChild) {
    try { loginChild.kill() } catch { /* already dead */ }
    loginChild = null
    loginUrl = null
    loginPending = null
  }
}

/** Official logout of the *active* grok identity. Caller should stop the engine first. */
export function grokLogout() {
  return new Promise((resolve, reject) => {
    execFile(GROK_BIN, ['logout'], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 300)))
      else resolve(String(stdout).trim())
    })
  })
}
