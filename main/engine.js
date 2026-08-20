// GrokEngine: supervise the ACP grok process. Never advertise terminal capability.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { EventEmitter } from 'node:events'
import { AcpClient } from './acp-client.js'

export const PERMISSION_MODES = ['ask', 'auto-safe', 'always-approve']

// Queue-entry owner identity. Owner-scoped queue ops (interject/remove) require the
// entry's owner to equal the request's clientIdentifier, so prompt() and queueOp()
// must send the same value (probed live: mismatched owner = silent no-op + rebroadcast).
const CLIENT_ID = 'grok-build-desktop'

export function findGrokBin() {
  const candidates = [
    join(homedir(), '.grok', 'bin', 'grok'),
    '/usr/local/bin/grok',
    '/opt/homebrew/bin/grok',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

// Deep-compare spawn opts (env / pluginDirs) for start() reuse.
function sameSpawnOpts(a, b) {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    const va = a[k]
    const vb = b[k]
    if (va === vb) continue
    if (va && vb && typeof va === 'object' && typeof vb === 'object') {
      if (!sameSpawnOpts(va, vb)) return false
      continue
    }
    return false
  }
  return true
}

export class GrokEngine extends EventEmitter {
  client = null
  initInfo = null
  spawnOpts = {}
  permissionMode = 'ask'
  #permissionWaiters = new Map()
  #permSeq = 0
  #startingPromise = null
  #startingOpts = null
  #intentionalStop = false
  #promptsInFlight = new Map()

  constructor({ log }) {
    super()
    this.log = log || (() => {})
  }

  get running() { return !!this.client?.alive }

  async start(opts = {}) {
    // Shallow merge: compare fully merged opts so a mid-start restart is not a no-op.
    const effective = { ...(this.#startingOpts || this.spawnOpts), ...opts }
    if (this.#startingPromise) {
      if (sameSpawnOpts(effective, this.#startingOpts)) return this.#startingPromise
      this.#startingOpts = effective
      this.#startingPromise = this.#trackStart(
        this.#startingPromise.catch(() => {}).then(() => this.#doStart(opts)),
      )
      return this.#startingPromise
    }
    this.#startingOpts = effective
    this.#startingPromise = this.#trackStart(this.#doStart(opts))
    return this.#startingPromise
  }

  /** Clear only this start; leave a queued one alone. */
  #trackStart(p) {
    const wrapped = p.finally(() => {
      if (this.#startingPromise === wrapped) {
        this.#startingPromise = null
        this.#startingOpts = null
      }
    })
    return wrapped
  }

  async #doStart(opts) {
    await this.stop()
    this.spawnOpts = { ...this.spawnOpts, ...opts }
    const bin = findGrokBin()
    if (!bin) throw new Error('找不到 grok 可执行文件（~/.grok/bin/grok）。请先安装并登录 Grok CLI。')

    const args = ['agent', '--no-leader']
    if (this.spawnOpts.model) args.push('-m', this.spawnOpts.model)
    if (this.spawnOpts.effort) args.push('--reasoning-effort', this.spawnOpts.effort)
    if (this.spawnOpts.agentProfile) args.push('--agent-profile', this.spawnOpts.agentProfile)
    for (const d of this.spawnOpts.pluginDirs || []) args.push('--plugin-dir', d)
    if (this.spawnOpts.xaiApiBaseUrl) args.push('--xai-api-base-url', this.spawnOpts.xaiApiBaseUrl)
    args.push('stdio')

    const env = { ...process.env, ...(this.spawnOpts.env || {}) }

    this.log(`spawn: ${bin} ${args.join(' ')}`)
    const client = new AcpClient({ binPath: bin, args, env, log: this.log })
    this.client = client
    this.#intentionalStop = false

    client.on('update', (params) => this.emit('session-update', params))
    client.on('notification', (msg) => this.#onNotification(msg))
    client.on('agent-request', (msg) => this.#onAgentRequest(msg))
    client.on('stderr', (chunk) => this.emit('engine-stderr', chunk))
    client.on('exit', (info) => {
      this.emit('engine-exit', { ...info, intentional: !!client.intentionalStop || this.#intentionalStop })
      for (const { resolve } of this.#permissionWaiters.values()) {
        resolve({ outcome: { outcome: 'cancelled' } })
      }
      this.#permissionWaiters.clear()
    })

    this.client.start()

    this.initInfo = await this.client.request('initialize', {
      protocolVersion: 1,
      // Do not declare terminal:true — grok then routes shell to us and every command fails.
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }, { timeoutMs: 30000 })

    this.emit('engine-ready', this.initInfo)
    return this.initInfo
  }

  async stop() {
    // Set before kill so the old process exit is marked intentional.
    this.#intentionalStop = true
    if (this.client) {
      const c = this.client
      this.client = null
      await c.stop().catch(() => {})
    }
  }

  /** Restart; pass resumeMcpServers or session-level MCP (Computer Use) is dropped. */
  async restart({ resumeSessionId, resumeCwd, resumeMcpServers, resumeMeta, ...opts } = {}) {
    await this.start(opts)
    if (resumeSessionId && resumeCwd) {
      return await this.loadSession({
        sessionId: resumeSessionId, cwd: resumeCwd, meta: resumeMeta, mcpServers: resumeMcpServers,
      })
    }
    return null
  }

  #require() {
    if (!this.client?.alive) throw new Error('引擎未运行')
    return this.client
  }

  // _meta.systemPromptOverride replaces the system prompt; _meta.rules appends <human_rules> (create only).
  // mcpServers: { name, command, args, env:[{name,value}] } — no type field. Empty = grok's own MCP only.
  async newSession({ cwd, meta, mcpServers }) {
    if (!cwd || !isAbsolute(cwd)) throw new Error('cwd 必须是绝对路径')
    const params = { cwd, mcpServers: mcpServers || [] }
    if (meta && Object.keys(meta).length) params._meta = meta
    return await this.#require().request('session/new', params, { timeoutMs: 60000 })
  }

  async loadSession({ sessionId, cwd, meta, mcpServers }) {
    const params = { sessionId, cwd, mcpServers: mcpServers || [] }
    if (meta && Object.keys(meta).length) params._meta = meta
    return await this.#require().request('session/load', params, { timeoutMs: 120000 })
  }

  async prompt({ sessionId, text, attachments }) {
    const client = this.#require()
    const blocks = []
    if (text) blocks.push({ type: 'text', text })
    for (const a of attachments || []) {
      blocks.push({ type: 'image', data: a.data, mimeType: a.mimeType })
    }
    const p = client.request('session/prompt', {
      sessionId,
      prompt: blocks,
      // clientIdentifier becomes the queue entry's owner (see CLIENT_ID note).
      // A prompt sent while a turn is running is queued engine-side; its RPC
      // resolves only when its own turn completes.
      _meta: { clientIdentifier: CLIENT_ID },
    })
    this.#promptsInFlight.set(sessionId, p)
    try {
      return await p
    } finally {
      this.#promptsInFlight.delete(sessionId)
    }
  }

  cancel({ sessionId }) {
    this.#require().notify('session/cancel', { sessionId })
  }

  /** Prompt-queue op (fire-and-forget ext notification). op: interject | remove.
   *  interject = send-now: on a normal turn the engine cancels the running turn
   *  (its RPC resolves with stopReason=cancelled) and immediately starts the queued
   *  prompt as the next turn; during an active goal turn it merges as a mid-turn
   *  interjection instead. The engine always rebroadcasts _x.ai/queue/changed
   *  afterwards (no-ops included) — the UI reconciles from that. */
  queueOp(op, { sessionId, id, expectedVersion }) {
    if (op !== 'interject' && op !== 'remove') throw new Error(`未知队列操作: ${op}`)
    this.#require().notify(`_x.ai/queue/${op}`, {
      sessionId, id, expectedVersion: expectedVersion || 0, clientIdentifier: CLIENT_ID,
    })
  }

  /** Live model switch; throw if unsupported so the caller can restart. */
  async setModel({ sessionId, modelId }) {
    return await this.#require().request('session/set_model', { sessionId, modelId }, { timeoutMs: 10000 })
  }

  /** ACP extension; live names use _x.ai/*, fall back without the prefix. */
  async ext(method, params = {}) {
    const client = this.#require()
    try {
      return await client.request('_' + method, params, { timeoutMs: 20000 })
    } catch (err) {
      if (!/method not found/i.test(err.message)) throw err
      return await client.request(method, params, { timeoutMs: 20000 })
    }
  }

  async billing() { return this.ext('x.ai/billing') }

  async authInfo() { return this.ext('x.ai/auth/info') }

  async checkSubscription() { return this.ext('x.ai/auth/check_subscription') }

  async autoTopupRule() { return this.ext('x.ai/auto-topup-rule') }

  /** Live effort switch (sessionConfig category "mode"). */
  async setMode({ sessionId, modeId }) {
    return await this.#require().request('session/set_mode', { sessionId, modeId }, { timeoutMs: 10000 })
  }

  setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) throw new Error(`未知权限模式: ${mode}`)
    this.permissionMode = mode
  }

  /** UI reply to a permission request. */
  resolvePermission(key, optionId) {
    const waiter = this.#permissionWaiters.get(key)
    if (!waiter) return false
    this.#permissionWaiters.delete(key)
    waiter.resolve(
      optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } },
    )
    return true
  }

  #onNotification(msg) {
    this.emit('engine-notification', { method: msg.method, params: msg.params })
  }

  async #onAgentRequest(msg) {
    const { id, method, params } = msg
    const client = this.client
    if (!client) return
    try {
      if (method === 'fs/read_text_file') {
        const result = await this.#fsRead(params)
        client.respond(id, result)
      } else if (method === 'fs/write_text_file') {
        await this.#fsWrite(params)
        client.respond(id, {})
      } else if (method === 'session/request_permission') {
        const result = await this.#onPermission(params)
        client.respond(id, result)
      } else {
        client.respondError(id, -32601, `method not supported: ${method}`)
      }
    } catch (err) {
      try { client.respondError(id, -32603, String(err?.message || err)) } catch {}
    }
  }

  async #fsRead({ path, line, limit }) {
    if (!path || !isAbsolute(path)) throw new Error('path 必须是绝对路径')
    let content = await readFile(path, 'utf8')
    if (line != null || limit != null) {
      const lines = content.split('\n')
      const start = Math.max(0, (line ?? 1) - 1)
      const end = limit != null ? start + limit : lines.length
      content = lines.slice(start, end).join('\n')
    }
    return { content }
  }

  async #fsWrite({ path, content }) {
    if (!path || !isAbsolute(path)) throw new Error('path 必须是绝对路径')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content ?? '', 'utf8')
  }

  pickAllowOption(options, { once = true } = {}) {
    const allows = (options || []).filter((o) => String(o.kind || '').startsWith('allow'))
    if (allows.length === 0) return options?.[0]?.optionId ?? null
    const prefer = once ? 'allow_once' : 'allow_always'
    return (allows.find((o) => o.kind === prefer) || allows[0]).optionId
  }

  async #onPermission(params) {
    const { sessionId, toolCall, options } = params || {}
    const mode = this.permissionMode

    if (mode === 'always-approve') {
      const optionId = this.pickAllowOption(options, { once: false })
      return { outcome: { outcome: 'selected', optionId } }
    }
    if (mode === 'auto-safe') {
      // Auto-allow read-only tools only.
      const readOnly = toolCall?._meta?.['x.ai/tool']?.read_only === true
        || toolCall?.kind === 'read'
      if (readOnly) {
        const optionId = this.pickAllowOption(options, { once: true })
        return { outcome: { outcome: 'selected', optionId } }
      }
    }

    // Ask the UI.
    const key = `perm-${++this.#permSeq}`
    return await new Promise((resolve) => {
      this.#permissionWaiters.set(key, { resolve })
      this.emit('permission-request', { key, sessionId, toolCall, options })
    })
  }
}
