
import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { createLogger } from './log.js'
import { GrokEngine } from './engine.js'
import { wireIpc } from './ipc.js'
import * as computerUse from './computer-use.js'
import { createCuOverlay } from './cu-overlay.js'
import { ensureDataRoot, loadSettings, loadCredentials } from './settings.js'
import { buildSpawnOpts } from './engine-opts.js'
import { seedPromptsDir } from './presets.js'
import { maskSecrets } from './mask-secrets.js'
import { grokLoginCancel, hydratePool, startAuthWatch, stopAuthWatch, setAccountLogger } from './account.js'
import { sourceRoot } from './paths.js'
import { createStayAwake, installBackgroundGuards } from './stay-awake.js'

const PROJECT_ROOT = sourceRoot()

delete process.env.ELECTRON_RUN_AS_NODE
delete process.env.NODE_OPTIONS

installBackgroundGuards(app)

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const log = createLogger(join(app.getPath('userData'), 'logs'))
log.info(`boot pid=${process.pid} electron=${process.versions.electron}`)
setAccountLogger({ info: (m) => log.info(m), warn: (m) => log.warn(m) })

ensureDataRoot()
seedPromptsDir()
const settingsRef = { value: loadSettings() }

const engine = new GrokEngine({ log: (m) => log.info(`[engine] ${m}`) })
engine.on('engine-stderr', (chunk) => log.info(`[grok-stderr] ${maskSecrets(String(chunk)).trimEnd()}`))
engine.on('engine-exit', ({ code, signal, intentional }) => {
  const line = `[engine] exited code=${code} signal=${signal}${intentional ? ' (intentional)' : ''}`
  if (intentional) log.info(line)
  else log.warn(line)
})

const stayAwake = createStayAwake({
  log: (m) => log.info(m),
  getBusy: () => engine.busy,
})
engine.on('busy-change', (busy) => {
  log.info(`stay-awake: engine busy=${busy}`)
  stayAwake.sync()
})
engine.on('engine-exit', () => stayAwake.sync())

// Computer-Use 横幅/隐藏主窗/桌面 2 提醒。回合结束(busy=false)或引擎退出时收场。
const cuOverlay = createCuOverlay({
  log: (m) => log.info(m),
  getWin: () => win,
  getSettings: () => settingsRef.value,
  getPermissionMode: () => engine.permissionMode,
  grokAlwaysApprove: computerUse.grokConfigAlwaysApprove,
})
engine.on('busy-change', (busy) => cuOverlay.syncBusy(busy))
engine.on('engine-exit', () => cuOverlay.end('engine-exit'))

let win = null
let isQuitting = false
let recovering = false
let recoverTries = 0
const MAX_RECOVER = 3

function claimRecovery() {
  if (isQuitting || recovering) return false
  if (recoverTries >= MAX_RECOVER) {
    log.error(`renderer recovery gave up after ${MAX_RECOVER} tries; 用菜单「显示 → 强制重新载入」手动重试`)
    return false
  }
  recovering = true
  recoverTries++
  return true
}


function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    webPreferences: {
      preload: join(PROJECT_ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })

  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('console-message', (ev) => {
    const level = typeof ev === 'object' && ev.level ? ev.level : null
    if (level === 'error' || level === 'warning') {
      log.warn(`[renderer:${level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') { log.info(`renderer gone: clean-exit`); return }
    log.error(`renderer gone: ${details.reason}`)
    recovering = false // 恢复期间再崩：消耗剩余次数，而不是把恢复永久锁死
    if (!claimRecovery()) return
    try { win.webContents.reload() } catch (e) { log.error(`reload failed: ${e.message}`) }
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    log.error(`load failed: ${code} ${desc} ${url || ''}`)
    recovering = false
    if (!claimRecovery()) return
    setTimeout(() => {
      if (isQuitting || !win || win.isDestroyed()) return
      win.loadFile(join(PROJECT_ROOT, 'renderer', 'index.html')).catch((e) => log.error(`reload failed: ${e.message}`))
    }, 500)
  })
  win.webContents.on('did-finish-load', () => {
    recovering = false
    recoverTries = 0
    // 重载后旧页面里的权限卡片全丢了；重发未决请求，否则 turn 永久挂起
    if (engine.running) engine.replayPendingPermissions()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.webContents.setBackgroundThrottling(false)
  win.loadFile(join(PROJECT_ROOT, 'renderer', 'index.html'))
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' })

  const shotArg = process.argv.find((a) => a.startsWith('--shot='))
  if (shotArg) {
    const outPath = shotArg.slice('--shot='.length)
    const autoArg = process.argv.find((a) => a.startsWith('--auto-test='))
    win.webContents.once('did-finish-load', async () => {
      try {
        if (autoArg) {
          const msgs = autoArg.slice('--auto-test='.length).split('||')
          await new Promise((r) => setTimeout(r, 3500))
          for (const msg of msgs) {
            await win.webContents.executeJavaScript(`(async () => {
              const input = document.getElementById('input')
              input.value = ${JSON.stringify(msg)}
              input.dispatchEvent(new Event('input'))
              document.getElementById('btnSend').click()
            })()`)
            for (let i = 0; i < 240; i++) {
              await new Promise((r) => setTimeout(r, 1000))
              const busy = await win.webContents.executeJavaScript(
                `document.getElementById('btnSend').classList.contains('stop')`)
              if (!busy && i > 3) break
            }
            await new Promise((r) => setTimeout(r, 800))
          }
        } else if (process.argv.find((a) => a.startsWith('--auto-js='))) {
          const code = process.argv.find((a) => a.startsWith('--auto-js=')).slice('--auto-js='.length)
          await new Promise((r) => setTimeout(r, 3500))
          await win.webContents.executeJavaScript(`(async () => { ${code} })()`)
          await new Promise((r) => setTimeout(r, 1000))
        } else {
          await new Promise((r) => setTimeout(r, 4000))
        }
        const img = await win.webContents.capturePage()
        const { writeFileSync } = await import('node:fs')
        writeFileSync(outPath, img.toPNG())
        log.info(`shot saved: ${outPath}`)
      } catch (err) {
        log.error(`shot failed: ${err.message}`)
      } finally {
        isQuitting = true
        app.quit()
      }
    })
  }
}

function buildMenu() {
  const zh = settingsRef.value?.ui?.language === 'zh'
  const L = (en, cn) => (zh ? cn : en)
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: L('About Grok Build Desktop', '关于 Grok Build Desktop') },
        { type: 'separator' },
        { role: 'hide', label: L('Hide', '隐藏') },
        { role: 'quit', label: L('Quit', '退出') },
      ],
    },
    { role: 'editMenu', label: L('Edit', '编辑') },
    {
      label: L('View', '显示'),
      submenu: [
        { role: 'reload', label: L('Reload', '重新载入') },
        { role: 'forceReload', label: L('Force Reload', '强制重新载入') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: L('Full Screen', '全屏') },
        { role: 'toggleDevTools', label: L('Developer Tools', '开发者工具') },
      ],
    },
    { role: 'windowMenu', label: L('Window', '窗口') },
    {
      label: L('Energy', '电源'),
      submenu: [
        {
          label: L('Turn Display Off', '关闭显示器'),
          click: () => {
            stayAwake.sleepDisplay().catch((e) => log.warn(`display sleep: ${e.message}`))
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('second-instance', () => {
  // will-quit 的 4 秒宽限期里窗口已销毁但 win 未置空
  if (win && !win.isDestroyed()) { win.show(); win.focus() }
})

app.on('activate', () => { if (win && !win.isDestroyed()) win.show() })

app.on('before-quit', () => { isQuitting = true })

app.on('will-quit', (e) => {
  e.preventDefault()
  grokLoginCancel()
  stopAuthWatch()
  stayAwake.stop()
  cuOverlay.stop()
  Promise.race([
    engine.stop(),
    new Promise((r) => setTimeout(r, 4000)),
  ]).finally(() => app.exit(0))
})

app.whenReady().then(() => {
  buildMenu()
  createWindow()
  // 协调口起不来 = MCP 侧拿不到 GBD_CU_COORD，control.mode 恒为 lite：横幅、Grok 指针、
  // full 模式的主窗隐藏 + setContentProtection、以及桌面 2 全都没有（共享鼠标模式下 Grok
  // 就在一块还摆着本 App 窗口的屏幕上动真光标）。桌面守卫不经协调口，照常生效。
  // 这些都不该拦住启动：宁可降级也要让人先用上应用。
  cuOverlay.start()
    .then(({ port, token }) => computerUse.setCoordinator({ port, token }))
    .catch((e) => log.warn(`cu-overlay coordinator failed: ${e.message}`))
  const applyKeepAwake = () => {
    stayAwake.setEnabled(settingsRef.value.engine?.keepAwake !== false)
  }
  applyKeepAwake()
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      {
        label: settingsRef.value?.ui?.language === 'zh' ? '关闭显示器' : 'Turn Display Off',
        click: () => stayAwake.sleepDisplay().catch((e) => log.warn(`display sleep: ${e.message}`)),
      },
    ]))
  }
  wireIpc({
    engine, win, log, settingsRef, stayAwake,
    onSettingsChanged: () => { buildMenu(); applyKeepAwake() },
  })
  try { hydratePool() } catch (e) { log.warn(`account pool hydrate: ${e.message}`) }
  startAuthWatch()
  const s = settingsRef.value
  try {
    engine.setPermissionMode(s.engine.permissionMode || 'ask')
  } catch (err) {
    log.warn(`permission mode invalid (${s.engine.permissionMode}), fallback to ask: ${err.message}`)
    try { engine.setPermissionMode('ask') } catch {}
  }
  engine.start(buildSpawnOpts(s, {}, loadCredentials)).catch((err) => {
    log.error(`engine autostart failed: ${err.message}`)
  })
  if (s.engine?.computerUse) computerUse.prewarm((m) => log.info(m)).catch(() => {})
})
