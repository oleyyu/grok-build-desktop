
// IPC: renderer <-> main. Events go out on evt:* (preload whitelist).
import { ipcMain, dialog, shell, app } from 'electron'
import { writeFileSync, mkdirSync, chmodSync, readdirSync, unlinkSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { listSessions, deleteSession, liveAgentTokens } from './sessions-store.js'
import { listPresets, resolvePresetText } from './presets.js'
import { getStats, invalidateStats } from './stats.js'
import {
  loadSettings, saveSettings, dataRoot,
  loadCredentials, saveCredential, credentialNames, touchWorkspace,
} from './settings.js'
import { PERMISSION_MODES } from './engine.js'
import { buildSpawnOpts } from './engine-opts.js'
import {
  getAccount, grokLogout, grokLoginStart,
  ingestAuthFile, syncActiveFromDisk, activateAccount, pickNextAccount,
  removeAccount, clearPool, recordUsage, mergePoolBilling, refreshInactiveUsage,
  isUsageLimitError, isBillingExhausted,
} from './account.js'
import * as computerUse from './computer-use.js'
import { readmePath } from './paths.js'

const str = (v) => typeof v === 'string' && v.length > 0
const optStr = (v) => v == null || typeof v === 'string'

const ERR_NO_ENGINE = 'Engine is not running / 引擎未运行'

function assertShape(ok, what) {
  if (!ok) throw new Error(`Invalid arguments / 参数不合法: ${what}`)
}

function assertScriptValue(v) {
  if (/[\0\r\n]/.test(v)) throw new Error('路径含非法字符')
  return v
}
function quoteSh(v) {
  return `'${v.replaceAll(`'`, `'\\''`)}'`
}

export function wireIpc({ engine, win, log, settingsRef, stayAwake, onSettingsChanged }) {
  const send = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  engine.on('session-update', (params) => send('evt:session-update', params))
  engine.on('engine-notification', (n) => {
    if (n.method === '_x.ai/sessions/changed') invalidateStats()
    send('evt:engine-notification', n)
  })
  engine.on('permission-request', (req) => send('evt:permission-request', req))
  engine.on('engine-exit', (info) => send('evt:engine-exit', info))
  engine.on('engine-ready', (init) => send('evt:engine-ready', init))

  ipcMain.handle('engine:start', async (_e, opts = {}) => {
    assertShape(optStr(opts.model) && optStr(opts.effort), 'engine:start')
    const s = settingsRef.value
    const spawnOpts = buildSpawnOpts(s, opts, loadCredentials)
    try {
      engine.setPermissionMode(s.engine.permissionMode || 'ask')
    } catch (e) {
      log.warn(`权限模式非法(${s.engine?.permissionMode})，落回 ask: ${e.message}`)
      engine.setPermissionMode('ask')
    }
    const init = await engine.start(spawnOpts)
    return init
  })

  ipcMain.handle('engine:stop', async () => { await engine.stop(); return true })
  ipcMain.handle('engine:info', () => ({
    running: engine.running,
    init: engine.initInfo,
    spawn: { model: engine.spawnOpts.model, effort: engine.spawnOpts.effort },
    permissionMode: engine.permissionMode,
  }))

  function buildProfileRules(p = {}) {
    const tv = (v) => String(v ?? '').trim()
    const lines = []
    if (tv(p.fullName)) lines.push(`The user's name is ${tv(p.fullName)}.`)
    if (tv(p.nickname)) lines.push(`Address the user as "${tv(p.nickname)}".`)
    if (tv(p.work)) lines.push(`The user's work: ${tv(p.work)}.`)
    if (tv(p.instructions)) lines.push(`Standing instructions from the user:\n${tv(p.instructions)}`)
    return lines.length ? lines.join('\n') : null
  }

  // 给 computer-use 选目标窗口时用来排除「本 App 自己的窗口」。
  // macOS 上 CGWindow 的 owner 是主进程，渲染进程一个窗口都不持有——真正管用的是 process.pid；
  // 渲染进程 pid 只是保险，而且 getOSProcessId() 在渲染进程没起来/已经没了时会抛或返回 0，
  // 不能让它连累建会话。（托管本 App 的终端没法按 pid 排除：父进程是 .command 脚本不是
  // Terminal，那边由 MCP server 按应用名跳过。）
  function hostPids() {
    const pids = [process.pid]
    try {
      if (win && !win.isDestroyed()) pids.push(win.webContents.getOSProcessId())
    } catch (e) {
      log.warn(`computer-use: 取渲染进程 pid 失败（主窗仍按主进程 pid 排除）: ${e.message}`)
    }
    return pids.filter((p) => Number.isInteger(p) && p > 0)
  }

  function computerUseServers() {
    const s = settingsRef.value
    if (!s.engine?.computerUse) return []
    if (!computerUse.available()) {
      log.warn('computer-use: 开关是开的，但 computer-use/ 文件缺失，本次不注入')
      return []
    }
    return [computerUse.mcpServerEntry({
      lang: s.ui?.language,
      ghost: s.engine?.cuGhost !== false,
      hostPids: hostPids(),
    })]
  }

  function currentModelForPreset() {
    const s = settingsRef.value
    return s.engine?.model || engine.spawnOpts.model
      || engine.initInfo?._meta?.modelState?.currentModelId || ''
  }

  function presetMeta(presetId, { model, cwd }) {
    if (!presetId) return undefined
    const text = resolvePresetText(presetId, { model: model || '', cwd })
    return text ? { systemPromptOverride: text } : undefined
  }

  ipcMain.handle('session:new', async (_e, { cwd, presetId } = {}) => {
    assertShape(str(cwd) && isAbsolute(cwd) && optStr(presetId), 'session:new')
    const s = settingsRef.value
    const wantModel = s.engine.model || engine.spawnOpts.model || null
    const meta = {}
    if (presetId) {
      const text = resolvePresetText(presetId, {
        model: currentModelForPreset(),
        cwd,
      })
      if (text) meta.systemPromptOverride = text
    }
    const rules = buildProfileRules(s.profile)
    if (rules) meta.rules = rules
    const result = await engine.newSession({ cwd, meta, mcpServers: computerUseServers() })
    const sessionId = result?.sessionId
    const alignment = { modelOk: true, effortOk: true, actualModel: null }
    if (sessionId) {
      const curModel = result?.models?.currentModelId
      if (wantModel && curModel && wantModel !== curModel) {
        await engine.setModel({ sessionId, modelId: wantModel }).catch((e) => {
          alignment.modelOk = false
          alignment.actualModel = curModel
          log.warn(`session:new 对齐模型失败（引擎仍是 ${curModel}）: ${e.message}`)
        })
      }
      if (s.engine.effort) {
        await engine.setMode({ sessionId, modeId: s.engine.effort }).catch((e) => {
          alignment.effortOk = false
          log.warn(`session:new 对齐档位失败: ${e.message}`)
        })
      }
    }
    result._alignment = alignment
    return result
  })

  ipcMain.handle('session:load', async (_e, { sessionId, cwd, presetId } = {}) => {
    assertShape(str(sessionId) && str(cwd) && isAbsolute(cwd), 'session:load')
    const meta = {}
    if (presetId) {
      const text = resolvePresetText(presetId, {
        model: currentModelForPreset(), cwd,
      })
      if (text) meta.systemPromptOverride = text
    }
    return await engine.loadSession({ sessionId, cwd, meta, mcpServers: computerUseServers() })
  })

  let accountSwitching = false
  async function restartEngine() {
    return await engine.start(buildSpawnOpts(settingsRef.value, {}, loadCredentials))
  }
  async function switchAccount(id, reason, { ignoreBusy = false } = {}) {
    if (accountSwitching) return null
    // Shared guard: account:activate checks busy first, but usage:get's idle
    // failover is fire-and-forget — a turn may have started between the check
    // and this call. Quota skips (next poll retries); manual still throws.
    // In-prompt failoverOnQuota passes ignoreBusy: queued prompts for the
    // same session keep busy true after the failing RPC's finally.
    if (engine.busy && !ignoreBusy) {
      if (reason === 'quota') return null
      throw new Error('还有回合在生成，等它结束后再切号')
    }
    accountSwitching = true
    try {
      syncActiveFromDisk()
      const from = getAccount()
      const next = activateAccount(id)
      try { await engine.stop() } catch {}
      try { await restartEngine() }
      catch (e) { log.warn(`切号后重启引擎失败: ${e.message}`) }
      send('evt:account-switched', {
        ok: true,
        reason: reason || 'manual',
        from: from.email || null,
        to: next.email,
        toId: next.id,
      })
      return next
    } finally {
      accountSwitching = false
    }
  }
  async function failoverOnQuota(err) {
    if (!isUsageLimitError(err)) return null
    const cur = getAccount()
    if (cur.activeId) recordUsage(cur.activeId, { config: { creditUsagePercent: 100 } })
    const next = pickNextAccount()
    if (!next) return null
    log.warn(`额度用尽（${cur.email || cur.activeId}），自动切到 ${next.email}`)
    return await switchAccount(next.id, 'quota', { ignoreBusy: true })
  }

  ipcMain.handle('session:prompt', async (_e, { sessionId, text, attachments } = {}) => {
    const okAtt = attachments == null || (Array.isArray(attachments)
      && attachments.length <= 4
      && attachments.every((a) => a && typeof a.data === 'string' && a.data.length > 0
        && a.data.length < 16e6 && /^image\/[a-z0-9.+-]+$/i.test(a.mimeType || '')))
    assertShape(str(sessionId) && typeof text === 'string' && okAtt
      && (text.length > 0 || (attachments && attachments.length)), 'session:prompt')
    try {
      return await engine.prompt({ sessionId, text, attachments })
    } catch (err) {
      const next = await failoverOnQuota(err)
      if (!next) throw err
      throw new Error(`ACCOUNT_SWITCHED:${next.email}`)
    }
  })

  ipcMain.handle('session:cancel', (_e, { sessionId } = {}) => {
    assertShape(str(sessionId), 'session:cancel')
    engine.cancel({ sessionId })
    return true
  })

  ipcMain.handle('workflow:stop', async (_e, { sessionId, runId, name, agentIds } = {}) => {
    assertShape(str(sessionId), 'workflow:stop sessionId')
    assertShape(optStr(runId) && optStr(name), 'workflow:stop')
    assertShape(
      agentIds == null
        || (Array.isArray(agentIds) && agentIds.length <= 64 && agentIds.every((id) => str(id))),
      'workflow:stop agents',
    )
    return await engine.stopWorkflow({ sessionId, runId, name, agentIds })
  })

  // Prompt-queue ops on a queued (not-yet-running) message (see engine.queueOp).
  const okQueueArgs = ({ sessionId, id, expectedVersion }) =>
    str(sessionId) && str(id) && (expectedVersion == null || typeof expectedVersion === 'number')
  ipcMain.handle('queue:interject', (_e, args = {}) => {
    assertShape(okQueueArgs(args), 'queue:interject')
    engine.queueOp('interject', args)
    return true
  })
  ipcMain.handle('queue:remove', (_e, args = {}) => {
    assertShape(okQueueArgs(args), 'queue:remove')
    engine.queueOp('remove', args)
    return true
  })

  ipcMain.handle('session:set-model', async (_e, { sessionId, modelId, cwd, presetId } = {}) => {
    assertShape(str(sessionId) && str(modelId) && str(cwd) && optStr(presetId), 'session:set-model')
    try {
      await engine.setModel({ sessionId, modelId })
      return { via: 'live' }
    } catch (err) {
      log.warn(`session/set_model 失败(${err.code ?? ''} ${err.message})，走重启路线`)
      // Rebuild spawn opts fully; shallow-merging the old process keeps stale model/provider.
      const loadRes = await engine.restart({
        ...buildSpawnOpts(settingsRef.value, { model: modelId }, loadCredentials),
        resumeSessionId: sessionId, resumeCwd: cwd,
        resumeMcpServers: computerUseServers(),
        resumeMeta: presetMeta(presetId, { model: modelId, cwd }),
      })
      let modelOk = true
      const actual = loadRes?.models?.currentModelId
      if (actual && actual !== modelId) {
        await engine.setModel({ sessionId, modelId }).catch((e) => {
          modelOk = false
          log.warn(`restart 后模型仍是 ${actual}（想要 ${modelId}）: ${e.message}`)
        })
      }
      const eff = settingsRef.value.engine.effort
      if (eff) {
        await engine.setMode({ sessionId, modeId: eff }).catch((e) =>
          log.warn(`restart 后钉档位失败（spawn 已带 ${eff}）: ${e.message}`))
      }
      // reloaded: restart+resume 已把整段历史重放给 renderer，它得按恢复纪律重建转录
      return { via: 'restart', reloaded: true, modelOk, actualModel: modelOk ? modelId : actual }
    }
  })

  ipcMain.handle('session:set-effort', async (_e, { sessionId, effortId, cwd, presetId } = {}) => {
    assertShape(str(sessionId) && str(effortId) && str(cwd) && optStr(presetId), 'session:set-effort')
    try {
      await engine.setMode({ sessionId, modeId: effortId })
      return { via: 'live' }
    } catch (err) {
      log.warn(`session/set_mode 失败(${err.code ?? ''} ${err.message})，走重启路线`)
      const loadRes = await engine.restart({
        ...buildSpawnOpts(settingsRef.value, { effort: effortId }, loadCredentials),
        resumeSessionId: sessionId, resumeCwd: cwd,
        resumeMcpServers: computerUseServers(),
        resumeMeta: presetMeta(presetId, { model: currentModelForPreset(), cwd }),
      })
      await engine.setMode({ sessionId, modeId: effortId }).catch((e) =>
        log.warn(`restart 后 set_mode 仍失败（spawn 已带 ${effortId}）: ${e.message}`))
      let modelOk = true
      const wantModel = settingsRef.value.engine.model
      const actual = loadRes?.models?.currentModelId
      if (wantModel && actual && actual !== wantModel) {
        await engine.setModel({ sessionId, modelId: wantModel }).catch((e) => {
          modelOk = false
          log.warn(`restart 后模型漂成 ${actual}（设置是 ${wantModel}）: ${e.message}`)
        })
      }
      return { via: 'restart', reloaded: true, modelOk, actualModel: modelOk ? (wantModel || actual) : actual }
    }
  })

  ipcMain.handle('permission:respond', (_e, { key, optionId } = {}) => {
    assertShape(str(key) && optStr(optionId), 'permission:respond')
    return engine.resolvePermission(key, optionId ?? null)
  })

  ipcMain.handle('permission:set-mode', (_e, { mode } = {}) => {
    assertShape(PERMISSION_MODES.includes(mode), 'permission:set-mode')
    engine.setPermissionMode(mode)
    const s = settingsRef.value
    s.engine.permissionMode = mode
    saveSettings(s)
    return true
  })

  // ---- Computer Use ----
  ipcMain.handle('computer-use:probe', async () => await computerUse.probe())
  ipcMain.handle('computer-use:prewarm', async () => {
    try { await computerUse.prewarm((m) => log.info(m)) }
    catch (e) { log.warn(`computer-use prewarm 失败: ${e.message}`) }
    return await computerUse.probe()
  })
  ipcMain.handle('computer-use:read-shot', (_e, { id } = {}) => {
    assertShape(str(id), 'computer-use:read-shot')
    return computerUse.readShot(id)
  })
  ipcMain.handle('computer-use:open-privacy', (_e, { which } = {}) => {
    assertShape(which === 'screen' || which === 'accessibility', 'computer-use:open-privacy')
    computerUse.openPrivacyPane(which)
    return true
  })

  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:delete', async (_e, { id, cwd } = {}) => {
    assertShape(str(id) && str(cwd), 'sessions:delete')
    return await deleteSession({ id, cwd })
  })
  ipcMain.handle('workflow:live-tokens', (_e, { cwd, agentIds } = {}) => {
    assertShape(Array.isArray(agentIds) && agentIds.length <= 32, 'workflow:live-tokens')
    assertShape(optStr(cwd), 'workflow:live-tokens cwd')
    return liveAgentTokens({ cwd, agentIds })
  })

  ipcMain.handle('presets:list', () => listPresets())

  ipcMain.handle('settings:get', () => settingsRef.value)
  ipcMain.handle('settings:set', (_e, partial = {}) => {
    const s = settingsRef.value
    for (const k of ['ui', 'engine', 'workspace', 'presets', 'providers', 'profile']) {
      if (partial[k] && typeof partial[k] === 'object') {
        s[k] = { ...s[k], ...partial[k] }
      }
    }
    saveSettings(s)
    try { onSettingsChanged?.() } catch {}
    return s
  })

  ipcMain.handle('credentials:names', () => credentialNames())
  ipcMain.handle('credentials:set', (_e, { name, value } = {}) => {
    assertShape(str(name) && str(value), 'credentials:set')
    saveCredential(name, value)
    return true
  })

  ipcMain.handle('workspace:pick', async () => {
    const zh = settingsRef.value?.ui?.language === 'zh'
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      message: zh ? '选择这个会话的工作目录' : 'Choose the working directory for this chat',
    })
    if (r.canceled || !r.filePaths[0]) return null
    const cwd = r.filePaths[0]
    const s = settingsRef.value
    touchWorkspace(s, cwd)
    saveSettings(s)
    return cwd
  })

  let termScriptSeq = 0
  ipcMain.handle('terminal:open', (_e, { cwd, resumeSessionId } = {}) => {
    assertShape(optStr(cwd) && optStr(resumeSessionId), 'terminal:open')
    const dir = cwd && isAbsolute(cwd) ? cwd : homedir()
    const grokBin = join(homedir(), '.grok', 'bin', 'grok')
    assertScriptValue(dir)
    let cmd = `cd ${quoteSh(dir)} && exec ${quoteSh(grokBin)}`
    if (resumeSessionId && /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(resumeSessionId)) {
      cmd = `cd ${quoteSh(dir)} && exec ${quoteSh(grokBin)} --resume ${quoteSh(resumeSessionId)}`
    }
    const scriptDir = join(app.getPath('userData'), 'cli')
    mkdirSync(scriptDir, { recursive: true })
    // Terminal 启动后才读 .command：固定文件名会被连点覆盖（两个终端都 resume 第二个会话）。
    // 每次唯一文件名；上次运行残留的旧脚本（pid 不同，Terminal 早读完了）顺手清掉
    try {
      for (const f of readdirSync(scriptDir)) {
        if (/^open-grok.*\.command$/.test(f) && !f.startsWith(`open-grok-${process.pid}-`)) {
          try { unlinkSync(join(scriptDir, f)) } catch {}
        }
      }
    } catch {}
    const script = join(scriptDir, `open-grok-${process.pid}-${termScriptSeq++}.command`)
    writeFileSync(script, `#!/bin/zsh\n${cmd}\n`, { encoding: 'utf8', mode: 0o700 })
    try { chmodSync(script, 0o700) } catch {}
    spawn('/usr/bin/open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' }).unref()
    return true
  })

  ipcMain.handle('stats:get', () => getStats())

  ipcMain.handle('usage:get', async (_e, { deep } = {}) => {
    if (!engine.running) throw new Error(ERR_NO_ENGINE)
    const live = await engine.billing()
    const cur = getAccount()
    if (cur.activeId) recordUsage(cur.activeId, live)
    if (deep) {
      try {
        await refreshInactiveUsage({ liveId: cur.activeId, log })
      } catch (e) {
        log.warn(`刷新其他账号额度失败: ${e.message}`)
      }
    }
    const merged = mergePoolBilling(live, cur.activeId)
    if (isBillingExhausted(live) && !engine.busy && !accountSwitching) {
      const next = pickNextAccount()
      if (next) {
        switchAccount(next.id, 'quota').catch((e) => log.warn(`空闲自动切号失败: ${e.message}`))
      }
    }
    return merged
  })
  ipcMain.handle('usage:topup-rule', async () => {
    if (!engine.running) throw new Error(ERR_NO_ENGINE)
    return await engine.autoTopupRule()
  })

  ipcMain.handle('account:info-live', async () => {
    if (!engine.running) throw new Error(ERR_NO_ENGINE)
    return await engine.authInfo()
  })
  ipcMain.handle('account:subscription', async () => {
    if (!engine.running) throw new Error(ERR_NO_ENGINE)
    return await engine.checkSubscription()
  })

  ipcMain.handle('account:get', () => getAccount())
  ipcMain.handle('account:activate', async (_e, { id } = {}) => {
    assertShape(str(id), 'account:activate')
    if (engine.busy) throw new Error('还有回合在生成，等它结束后再切号')
    await switchAccount(id, 'manual')
    return getAccount()
  })
  ipcMain.handle('account:remove', async (_e, { id } = {}) => {
    assertShape(str(id), 'account:remove')
    if (engine.busy) throw new Error('还有回合在生成，等它结束后再移除账号')
    const cur = getAccount()
    const r = removeAccount(id)
    if (r.emptied) {
      try { await engine.stop() } catch {}
      try { await grokLogout() } catch {}
    } else if (cur.activeId === id) {
      try { await engine.stop() } catch {}
      try { await restartEngine() }
      catch (e) { log.warn(`移除当前账号后重启引擎失败: ${e.message}`) }
    }
    return getAccount()
  })
  ipcMain.handle('account:logout', async () => {
    try { await engine.stop() } catch {}
    await grokLogout()
    clearPool()
    return getAccount()
  })
  ipcMain.handle('account:login-start', async () => {
    try { await engine.stop() } catch {}
    const { url } = await grokLoginStart({
      onDone: async (ok) => {
        try { ingestAuthFile() } catch {}
        if (ok || getAccount().loggedIn) {
          try { await restartEngine() }
          catch (e) { log.warn(`登录后重启引擎失败: ${e.message}`) }
        }
        send('evt:account-login-done', { ok, account: getAccount() })
      },
    })
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle('app:open-data-dir', async () => {
    const err = await shell.openPath(dataRoot())
    if (err) throw new Error(err)
    return true
  })
  ipcMain.handle('app:open-logs', async () => {
    const err = await shell.openPath(join(app.getPath('userData'), 'logs'))
    if (err) throw new Error(err)
    return true
  })
  ipcMain.handle('app:open-readme', async () => {
    const err = await shell.openPath(readmePath())
    if (err) throw new Error(err)
    return true
  })
  ipcMain.handle('app:quit', () => { app.quit(); return true })
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('display:sleep', async () => {
    if (!stayAwake) throw new Error('stay-awake is not wired')
    await stayAwake.sleepDisplay()
    return true
  })
  ipcMain.handle('display:stay-awake-status', () => stayAwake?.status() || { enabled: false, holding: false })
}
