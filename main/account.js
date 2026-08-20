// Account: identity-only view of ~/.grok/auth.json; tokens never leave main.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile, spawn } from 'node:child_process'

const AUTH_FILE = join(homedir(), '.grok', 'auth.json')
export const GROK_BIN = join(homedir(), '.grok', 'bin', 'grok')

/** First email-bearing entry under auth.json's issuer::client_id groups. */
export function getAccount() {
  if (!existsSync(AUTH_FILE)) return { loggedIn: false }
  try {
    const raw = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
    for (const [key, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object' || !v.email) continue
      return {
        loggedIn: true,
        email: v.email,
        name: [v.first_name, v.last_name].filter(Boolean).join(' ') || null,
        userId: v.user_id || null,
        teamId: v.team_id || null,
        authMode: v.auth_mode || null,
        issuer: v.oidc_issuer || key.split('::')[0] || null,
        createTime: v.create_time || null,
        expiresAt: v.expires_at || null,
        retentionOptOut: v.coding_data_retention_opt_out === true,
      }
    }
  } catch {
    /* treat parse failure as logged-out */
  }
  return { loggedIn: false }
}

let loginChild = null
let loginUrl = null      // in-flight auth URL (reused on reentry)
let loginPending = null
let loginDoneCbs = []

/**
 * Spawn `grok login --oauth` (no TTY). Resolves with the auth URL; CLI hosts
 * the 127.0.0.1 callback. Do not kill an in-flight child — that tears down
 * the callback server and the already-open browser page gets connection refused.
 * Only { force: true } cancels and restarts.
 */
export function grokLoginStart({ onDone, force = false } = {}) {
  if (loginChild && !force) {
    // Keep a single onDone; stacking would restart the engine twice.
    if (onDone) { loginDoneCbs.length = 0; loginDoneCbs.push(onDone) }
    if (loginUrl) return Promise.resolve({ url: loginUrl })
    if (loginPending) return loginPending
  }
  if (force) grokLoginCancel()
  const cbs = onDone ? [onDone] : []
  loginDoneCbs = cbs
  const fireDone = (ok) => {
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

/** Official logout. Caller should stop the engine first. */
export function grokLogout() {
  return new Promise((resolve, reject) => {
    execFile(GROK_BIN, ['logout'], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 300)))
      else resolve(String(stdout).trim())
    })
  })
}
