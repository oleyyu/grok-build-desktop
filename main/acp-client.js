// ACP client for `grok agent --no-leader stdio`. Line-delimited JSON-RPC 2.0;
// stderr is human logs, never protocol.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

export class AcpClient extends EventEmitter {
  #child = null
  #nextId = 1
  #pending = new Map() // id -> {resolve, reject, method}
  #buf = ''
  #closed = false
  intentionalStop = false // set by stop(); exit consumers distinguish crash vs we-stopped

  constructor({ binPath, args, cwd, env, log }) {
    super()
    this.binPath = binPath
    this.args = args
    this.cwd = cwd || process.env.HOME
    this.env = env
    this.log = log || (() => {})
  }

  get alive() {
    return !!this.#child && this.#child.exitCode === null && !this.#closed
  }

  get pid() {
    return this.#child?.pid ?? null
  }

  start() {
    // Strip host Electron env so the grok child is not polluted.
    const env = { ...(this.env || process.env) }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    delete env.NODE_OPTIONS

    this.#child = spawn(this.binPath, this.args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk) => this.#onData(chunk))
    this.#child.stderr.on('data', (chunk) => this.emit('stderr', chunk))
    // Stream 'error' is async; unhandled EPIPE on a dying stdin pops Electron's crash dialog.
    this.#child.stdin.on('error', (err) => this.log(`stdin error: ${err.message}`))
    this.#child.stdout.on('error', () => {})
    this.#child.stderr.on('error', () => {})
    this.#child.on('error', (err) => {
      this.log(`spawn error: ${err.message}`)
      this.#failAll(new Error(`grok 进程启动失败: ${err.message}`))
      this.emit('exit', { code: null, signal: null, error: err })
    })
    this.#child.on('exit', (code, signal) => {
      this.#closed = true
      this.#failAll(new Error(`grok 进程已退出 (code=${code} signal=${signal})`))
      this.emit('exit', { code, signal })
    })
    return this
  }

  #onData(chunk) {
    // Pipe-buffered stdout can still arrive after 'exit'/stop(): drop it, or a dead
    // engine's traffic gets routed while a fresh client is already running.
    if (this.#closed) return
    this.#buf += chunk
    let idx
    while ((idx = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, idx).trim()
      this.#buf = this.#buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        this.log(`bad json line (${line.length}B), skipped`)
        continue
      }
      this.#dispatch(msg)
    }
  }

  #dispatch(msg) {
    if (this.#closed) return // a listener may close us mid-#onData loop
    // Response to our request
    if (msg.id !== undefined && msg.method === undefined) {
      const pend = this.#pending.get(msg.id)
      if (!pend) return
      this.#pending.delete(msg.id)
      if (msg.error) {
        const e = new Error(msg.error.message || 'agent error')
        e.code = msg.error.code
        e.data = msg.error.data
        e.rpc = true
        pend.reject(e)
      } else {
        pend.resolve(msg.result)
      }
      return
    }
    // Agent -> client request (has id; must reply)
    if (msg.id !== undefined && msg.method !== undefined) {
      this.emit('agent-request', msg)
      return
    }
    // Notification (no id)
    if (msg.method !== undefined) {
      if (msg.method === 'session/update') {
        this.emit('update', msg.params)
      } else {
        this.emit('notification', msg)
      }
    }
  }

  #failAll(err) {
    for (const { reject } of this.#pending.values()) reject(err)
    this.#pending.clear()
  }

  #write(obj) {
    // alive already includes !#closed, so writes during shutdown fail here instead of EPIPE.
    if (!this.alive || !this.#child.stdin.writable) throw new Error('grok 进程不在运行')
    this.#child.stdin.write(JSON.stringify(obj) + '\n')
  }

  request(method, params, { timeoutMs = 0 } = {}) {
    const id = this.#nextId++
    let timer = null
    const p = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.#pending.has(id)) {
            this.#pending.delete(id)
            reject(new Error(`${method} 超时 (${timeoutMs}ms)`))
          }
        }, timeoutMs)
        timer.unref?.()
      }
    })
    try {
      this.#write({ jsonrpc: '2.0', id, method, params })
    } catch (err) {
      // Sync write failure: reap the entry or the timer/#failAll later rejects a promise nobody holds.
      this.#pending.delete(id)
      if (timer) clearTimeout(timer)
      throw err
    }
    return p
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  respond(id, result) {
    this.#write({ jsonrpc: '2.0', id, result })
  }

  respondError(id, code, message) {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  async stop({ graceMs = 3000 } = {}) {
    // Close before SIGTERM: between kill and 'exit', alive was true and replies EPIPE'd.
    this.#closed = true
    this.intentionalStop = true
    // Reject in-flight RPCs now — session/prompt has no timeout, and 'exit' may
    // never arrive (stuck child) or may fire after the engine has dropped listeners.
    this.#failAll(new Error('grok 进程已停止'))
    if (!this.#child || this.#child.exitCode !== null) return
    const child = this.#child
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        resolve()
      }, graceMs)
      t.unref?.()
      child.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
}
