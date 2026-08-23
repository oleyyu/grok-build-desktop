// Computer-Use 控制会话的宿主侧：顶部「Grok is working on your Mac.」横幅、
// 隐藏主窗（always-approve 才藏，ask/auto-safe 用户要点权限卡）、「桌面 2」系统通知，
// 以及给 computer-use MCP server 用的 127.0.0.1 协调口（/begin /state /notify /end）。
// 横幅 setContentProtection(true)：物理屏上可见，screencapture 里不存在——AI 永远拍不到它；
// 同理 full 模式给主窗也开保护，用户中途把窗口唤回来也不会入镜。

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { BrowserWindow, Notification, screen } from 'electron'
import { sourceRoot } from './paths.js'

const IDLE_QUIESCE_MS = 10 * 60 * 1000   // MCP server 死得不明不白时的兜底（正路是 busy=false / 引擎退出）
const NOTIFY_DEDUP_MS = 10 * 60 * 1000   // 同一种状态别反复弹通知（跨回合有效；状态一变立刻重播）

export function createCuOverlay({ log, getWin, getSettings, getPermissionMode, grokAlwaysApprove }) {
  const token = randomBytes(16).toString('hex')
  let server = null
  let port = 0
  let banner = null
  let active = false
  let paused = false
  let mode = 'lite'
  let hidMainWin = false
  let protectedMainWin = false
  let notifiedAt = 0
  let notifyKey = ''
  let idleTimer = null
  let idled = false
  let sessionId = 1
  let cursorWin = null
  let cursorHideTimer = null
  let ghostMode = false
  let targetApp = ''
  // 上一次「播报出去」的模式。ghostMode 每次 begin()/end() 都会清零，拿它比不出降级；
  // 这个值只在 stop() 清，所以跨回合的 ghost→共享光标才有人发现。
  let lastAnnouncedGhost = null

  const lang = () => (getSettings()?.ui?.language === 'zh' ? 'zh' : 'en')

  function bumpIdle() {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(idleQuiesce, IDLE_QUIESCE_MS)
  }

  const BANNER_W = 720, BANNER_H = 48
  function bannerBounds() {
    const wa = screen.getPrimaryDisplay().workArea
    return { x: Math.round(wa.x + (wa.width - BANNER_W) / 2), y: wa.y + 6, width: BANNER_W, height: BANNER_H }
  }

  function ensureBanner() {
    if (banner && !banner.isDestroyed()) return banner
    const b0 = bannerBounds()
    banner = new BrowserWindow({
      width: b0.width, height: b0.height,
      x: b0.x, y: b0.y,
      frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false,
      focusable: false, alwaysOnTop: true, hasShadow: false, skipTaskbar: true,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    banner.setAlwaysOnTop(true, 'screen-saver')
    // 用户在哪个桌面都看得见（含全屏 app）；skipTransformProcessType 别动 Dock 图标
    banner.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    banner.setContentProtection(true)   // 不进截图（用户点名：别把横幅拍进去）
    banner.setIgnoreMouseEvents(true)   // AI 点到横幅下方的东西时点击穿透
    banner.webContents.on('did-finish-load', () => pushBannerState())
    banner.on('closed', () => { banner = null })
    banner.loadFile(join(sourceRoot(), 'renderer', 'cu-banner.html'))
      .catch((e) => log('cu-overlay: banner load failed ' + e.message))
    return banner
  }

  function pushBannerState() {
    if (!banner || banner.isDestroyed()) return
    const js = `window.__setState && window.__setState(${JSON.stringify({ paused, lang: lang(), ghost: ghostMode, app: targetApp })})`
    banner.webContents.executeJavaScript(js).catch(() => {})
  }

  // Grok 专属指针：ghost 模式下 Grok 不碰系统光标，它「在哪儿操作」只能靠这个浮层告诉用户。
  const CURSOR_W = 120, CURSOR_H = 60
  function ensureCursorWin() {
    if (cursorWin && !cursorWin.isDestroyed()) return cursorWin
    // 首次先放在屏幕外，等 moveCursor 定好位置再显示（show:false，不会闪一下）
    cursorWin = new BrowserWindow({
      width: CURSOR_W, height: CURSOR_H, x: -500, y: -500,
      frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, focusable: false, alwaysOnTop: true,
      hasShadow: false, skipTaskbar: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    cursorWin.setAlwaysOnTop(true, 'screen-saver')
    cursorWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    cursorWin.setContentProtection(true)  // Grok 自己的截图里不能有这个指针
    cursorWin.setIgnoreMouseEvents(true)
    cursorWin.on('closed', () => { cursorWin = null })
    cursorWin.loadFile(join(sourceRoot(), 'renderer', 'cu-cursor.html'))
      .catch((e) => log('cu-overlay: cursor load failed ' + e.message))
    return cursorWin
  }

  function moveCursor(p) {
    bumpIdle()
    if (!active) return
    const { x, y, kind, hide } = p || {}
    // target_window 换窗时只会走 /cursor（不重发 /notify，否则又是一轮隐窗+通知）：
    // 横幅上的 App 名得从这里跟着换，不然用户看到的还是上一个窗口。
    if (typeof p?.app === 'string' && p.app && p.app !== targetApp) {
      targetApp = p.app
      pushBannerState()
    }
    const c = ensureCursorWin()
    if (c.isDestroyed()) return
    // 动作前先把指针收掉：它 always-on-top 地压在落点上，用户就看不清 Grok 到底点了哪个控件、
    // 点完有没有反应（动作做完 server 会在真正的落点把它画回来）。
    if (hide) {
      clearTimeout(cursorHideTimer)
      cursorHideTimer = null
      if (c.isVisible()) c.hide()
      return
    }
    // 指针尖对准目标点：内容整体向右下缩进 14px（点击波纹要往左上扩，窗口外的像素直接被裁掉），
    // 加上 SVG 尖端本身在 (2,1.5)，窗口左上角落在目标点左上 16px 处正好对齐。
    c.setBounds({ x: Math.round(x) - 16, y: Math.round(y) - 16, width: CURSOR_W, height: CURSOR_H })
    if (!c.isVisible()) c.showInactive()
    try { c.webContents.invalidate() } catch {}
    c.webContents.executeJavaScript(`window.__cursorPing && window.__cursorPing(${JSON.stringify(kind || 'move')})`)
      .catch(() => {})
    clearTimeout(cursorHideTimer)
    cursorHideTimer = setTimeout(() => {
      if (cursorWin && !cursorWin.isDestroyed()) cursorWin.hide()
    }, 25000)
  }

  function resolveMode() {
    const s = getSettings() || {}
    if (s.engine?.cuHideApp === false) return 'lite'
    if (getPermissionMode() === 'always-approve') return 'full'
    try { if (grokAlwaysApprove()) return 'full' } catch {}
    return 'lite' // 逐步批准模式：权限卡在主窗里，藏了用户就点不了了
  }

  // 主窗还原：hide/contentProtection 都是「藏了就必须还」的成对操作，
  // 收摊路径（end / 空闲兜底）各调一次，重复调用无副作用。
  function restoreMainWin() {
    const win = getWin()
    if (win && !win.isDestroyed()) {
      if (protectedMainWin) { try { win.setContentProtection(false) } catch {} }
      // showInactive：把窗口还回去但不抢焦点，用户在桌面 2 时不能把人硬拽回来
      if (hidMainWin && !win.isVisible()) win.showInactive()
    }
    protectedMainWin = false
    hidMainWin = false
  }

  function showBanner() {
    const b = ensureBanner()
    // workArea 只在建窗时算过一次；换分辨率/Dock 挪位/接显示器之后横幅会一直偏，每轮重算一遍
    b.setBounds(bannerBounds())
    pushBannerState()
    if (!b.isVisible()) b.showInactive()
    return b
  }

  // 空闲兜底：横幅和指针收掉、主窗还给用户，但会话不算结束 —— sessionId 不变、fresh 仍为 false，
  // 免得一次长思考/长构建之后 server 以为是新一轮，半路重新挑一个目标窗口。
  function idleQuiesce() {
    idleTimer = null
    if (!active || idled) return
    idled = true
    if (banner && !banner.isDestroyed()) banner.hide()
    clearTimeout(cursorHideTimer)
    cursorHideTimer = null
    if (cursorWin && !cursorWin.isDestroyed()) cursorWin.hide()
    restoreMainWin()
    log('cu-overlay: idle quiesce (session kept)')
  }

  function begin() {
    bumpIdle()
    if (active) {
      // 兜底之后又来活了：把横幅和 full 模式的隐窗/防拍重新挂上，但不重弹通知、不重新锚定
      if (idled) {
        idled = false
        showBanner()
        applyWindowMode()
      }
      return { ok: true, fresh: false, mode, sessionId }
    }
    active = true
    paused = false
    idled = false
    mode = resolveMode()
    ghostMode = false
    showBanner()
    // 先挡出截图（无论哪种模式都不该入镜）；隐不隐窗口等 /notify 知道是不是 ghost 再定
    const win = getWin()
    if (win && !win.isDestroyed() && mode === 'full') {
      try { win.setContentProtection(true); protectedMainWin = true } catch {}
    }
    log(`cu-overlay: begin mode=${mode} session=${sessionId}`)
    return { ok: true, fresh: true, mode, sessionId }
  }

  // ghost/classic 各自的主窗处置，notifyUser 和空闲恢复共用（恢复时不能重弹通知）
  function applyWindowMode() {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    // full 模式主窗一律不入镜：ghost 下窗口还开着，用户随时会把聊天窗唤回前台
    if (mode === 'full' && !protectedMainWin) {
      try { win.setContentProtection(true); protectedMainWin = true } catch {}
    }
    if (ghostMode) {
      // ghost：Grok 有独立指针，只操作一个窗口 —— 主窗不必藏，用户想边看聊天边干自己的事
      if (hidMainWin && !win.isVisible()) {
        win.showInactive()
        hidMainWin = false
      }
      return
    }
    if (mode !== 'full') return
    // 全屏窗不 hide：会留下一个空的全屏 Space，contentProtection 已保证不入镜
    if (win.isVisible() && !win.isFullScreen()) {
      win.hide()
      hidMainWin = true
    }
  }

  function stateUpdate(p) {
    bumpIdle()
    if (!active) return
    if (paused === !!p) return
    paused = !!p
    pushBannerState()
  }

  function notifyUser(p) {
    // 会话已经结束（Stop 之后晚到的 /notify）：绝不能再去 hide 主窗 —— end() 已经收过摊了，
    // 没人会再把窗口还回来，用户按完 Stop 只能去点 Dock 图标。
    if (!active) return
    bumpIdle()
    const zh = lang() === 'zh'
    ghostMode = !!p.ghost
    targetApp = String(p.app || '')
    pushBannerState()
    applyWindowMode()

    const now = Date.now()
    // 去重只对「同一种状态」生效：ghost/mode/desktop/目标窗口任一变了都必须重新播报 ——
    // 尤其 ghost→共享光标的降级，用户上一条听到的还是「你的鼠标不受影响」。
    const key = JSON.stringify([ghostMode, p.mode || '', p.desktop || '', !!p.spacesOk, targetApp])
    if (key === notifyKey && now - notifiedAt < NOTIFY_DEDUP_MS) return
    notifyKey = key
    notifiedAt = now
    const downgraded = lastAnnouncedGhost === true && !ghostMode
    let body
    if (ghostMode) {
      const where = p.desktop === 'created'
        ? (zh ? '已为你新建桌面 2（按 ⌃→ 过去），' : 'Created desktop 2 for you (press ⌃→), ')
        : p.desktop === 'exists'
          ? (zh ? '想干别的可按 ⌃→ 切到另一个桌面，' : 'Press ⌃→ for your other desktop; ')
          : ''
      body = zh
        ? `${where}Grok 用自己的紫色指针操作「${p.app || '目标窗口'}」。你的鼠标键盘不受影响，随时切回来看都不会打断它。`
        : `${where}Grok is using its own purple pointer in “${p.app || 'the target window'}”. Your mouse and keyboard stay free, and switching back to watch won’t interrupt it.`
    } else if (!p.spacesOk) {
      body = zh
        ? 'Grok 正在操作这台 Mac。本系统检测不到桌面切换，期间请不要抢鼠标键盘。'
        : 'Grok is controlling this Mac. Desktop-switch detection is unavailable — please avoid using the mouse or keyboard meanwhile.'
    } else if (p.mode !== 'full') {
      body = zh
        ? 'Grok 正在操作这台 Mac（每一步需要你批准）。切到别的桌面时它会自动暂停。'
        : 'Grok is controlling this Mac (each step needs your approval). It pauses automatically if you switch desktops.'
    } else if (p.desktop === 'created') {
      body = zh
        ? '已为你新建了一个桌面：按 ⌃→ 切过去干别的。Grok 只在原桌面工作，你切走它就暂停，切回来自动继续。'
        : 'Created a new desktop for you — press ⌃→ to switch and do your own thing. Grok stays on the original desktop, pauses while you are away, resumes when you return.'
    } else if (p.desktop === 'exists') {
      body = zh
        ? '想干别的可以按 ⌃→ 切到另一个桌面。Grok 只在原桌面工作，你切走它就暂停，切回来自动继续。'
        : 'Press ⌃→ to another desktop to do your own thing. Grok stays on the original desktop, pauses while you are away, resumes when you return.'
    } else {
      body = zh
        ? '没能自动新建桌面——可在调度中心（⌃↑ 后点右上角＋）手动建一个再切过去。Grok 只在原桌面工作，你切走它就暂停。'
        : 'Could not create a desktop automatically — add one in Mission Control (⌃↑, then + at top right). Grok stays on the original desktop and pauses while you are away.'
    }
    // borrowsMouse 是 server 专门发过来给宿主播报的：共享光标模式下 Grok 动的就是用户手上
    // 那只鼠标，桌面 2 甚至是刚借它去调度中心点出来的。降级前缀里说过的部分这里不重复。
    if (!ghostMode && p.borrowsMouse) {
      const mine = !downgraded
      const mc = p.desktop === 'created'
      const note = zh
        ? (mine && mc ? 'Grok 动的就是你手上那只鼠标——刚才那个桌面就是借它去调度中心点出来的。'
          : mc ? '刚才那个桌面是借你的鼠标去调度中心点出来的。'
            : mine ? 'Grok 动的就是你手上那只鼠标。' : '')
        : (mine && mc ? 'Grok moves your real mouse — it just borrowed it in Mission Control to add that desktop.'
          : mc ? 'It just borrowed your real mouse in Mission Control to add that desktop.'
            : mine ? 'Grok moves your real mouse.' : '')
      if (note) body += (zh ? '' : ' ') + note
    }
    // 降级 = 「你的鼠标要被借走了」，得说清为什么：否则用户只看到指针莫名其妙开始自己动
    if (downgraded) {
      const why = String(p.reason || p.why || '').trim()
      body = (zh
        ? `独立指针不可用${why ? `（${why}）` : ''}，Grok 改用你的鼠标：`
        : `Independent pointer unavailable${why ? ` (${why})` : ''} — Grok now shares your mouse. `) + body
    }
    try {
      if (Notification.isSupported()) {
        new Notification({ title: zh ? 'Grok 正在操作你的 Mac' : 'Grok is working on your Mac', body }).show()
      }
    } catch (e) { log('cu-overlay: notification failed ' + e.message) }
    lastAnnouncedGhost = ghostMode
  }

  function end(reason) {
    clearTimeout(idleTimer)
    idleTimer = null
    clearTimeout(cursorHideTimer)
    cursorHideTimer = null
    if (banner && !banner.isDestroyed()) banner.hide()
    if (cursorWin && !cursorWin.isDestroyed()) cursorWin.hide()
    // 还原放在 active 短路之前：晚到的 /notify 或半路的异常都可能留下藏起来的主窗，
    // 再 end 一次必须能把它还回来（幂等）。
    restoreMainWin()
    if (!active) return
    active = false
    paused = false
    idled = false
    ghostMode = false
    targetApp = ''
    mode = 'lite'          // 不重置的话，会话之后晚到的 /notify 会照着上一轮的 full 去藏主窗
    // notifiedAt / notifyKey 故意留着：end() 每个回合末尾都跑，在这儿清掉等于去重永远失效，
    // 用户连发五条消息就吃五条一模一样的系统通知。状态变了 key 就不同，照样会立刻重播。
    sessionId++            // 真正的回合边界（turn-end / engine-exit / /end）才换号，空闲兜底不换
    log(`cu-overlay: end (${reason})`)
  }

  function handleHttp(req, res) {
    const fin = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.method !== 'POST') return fin(405, { ok: false })
    if (req.headers['x-gbd-token'] !== token) return fin(403, { ok: false })
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 16384) req.destroy()
    })
    req.on('end', () => {
      let p = {}
      try { p = JSON.parse(body || '{}') } catch {}
      try {
        switch (req.url) {
          case '/begin': return fin(200, begin())
          case '/state': stateUpdate(!!p.paused); return fin(200, { ok: true })
          case '/cursor': moveCursor(p); return fin(200, { ok: true })
          case '/notify': notifyUser(p); return fin(200, { ok: true })
          case '/end': end('mcp'); return fin(200, { ok: true })
          default: return fin(404, { ok: false })
        }
      } catch (e) {
        log('cu-overlay: http handler ' + (e?.stack || e))
        return fin(500, { ok: false })
      }
    })
    req.on('error', () => {})
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = createServer(handleHttp)
      server.on('error', (e) => { log('cu-overlay: server error ' + e.message); reject(e) })
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port
        log(`cu-overlay: coordinator on 127.0.0.1:${port}`)
        resolve({ port, token })
      })
    })
  }

  function stop() {
    end('shutdown')
    // 去重状态跨回合有效，只有整个进程收摊才清
    notifiedAt = 0
    notifyKey = ''
    lastAnnouncedGhost = null
    try { server?.close() } catch {}
    try { if (banner && !banner.isDestroyed()) banner.destroy() } catch {}
    try { if (cursorWin && !cursorWin.isDestroyed()) cursorWin.destroy() } catch {}
    banner = null
    cursorWin = null
  }

  return {
    start, stop, end,
    syncBusy(busy) { if (!busy) end('turn-end') },
    get port() { return port },
    get token() { return token },
    get active() { return active },
  }
}
