// Keep the Mac from idle-sleeping while Grok is working.
// Display sleep / lock / blank is allowed (no prevent-display-sleep).
// Lid-close and Apple-menu Sleep still pause the machine — those are hardware.

import { app, powerSaveBlocker, powerMonitor } from 'electron'
import { spawn, execFile } from 'node:child_process'

export function installBackgroundGuards(app) {
  // Do not disable Chromium background throttling / occluded-window freezing.
  // Those switches kept the renderer at full clock even while idle in the
  // background, which is the idle-battery leak. The grok child and main
  // process keep working; stay-awake holds prevent-app-suspension only
  // while engine.busy. syncRendererThrottle() unthrottles the page for the
  // duration of a turn so ask-mode permission cards and stall guards stay live.
  void app
}

/** Throttle the renderer unless a turn is in flight AND the window is actually on screen. */
export function syncRendererThrottle(win, keepLive) {
  if (!win || win.isDestroyed()) return
  try { win.webContents.setBackgroundThrottling(!keepLive) } catch {}
}

export function createStayAwake({ log = () => {}, getBusy = () => false, onChange = () => {} } = {}) {
  let enabled = true
  let blockerId = null
  let cafe = null
  let cafeGen = 0
  let wired = false
  let displayOffHold = false
  let displayOffQuietUntil = 0

  function holding() {
    // Only block idle sleep while Grok is actually working.
    // displayOffHold is for renderer/GPU (blanked screen) — it must not
    // keep caffeinate running after the turn has already ended.
    return enabled && !!getBusy()
  }

  function acquire() {
    if (!app.isReady()) {
      app.once('ready', () => { if (holding()) acquire() })
      return
    }
    if (blockerId == null || !powerSaveBlocker.isStarted(blockerId)) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension')
      log(`stay-awake: on (prevent-app-suspension id=${blockerId})`)
    }
    startCaffeinate()
  }

  function startCaffeinate() {
    if (cafe && cafe.exitCode == null && !cafe.killed) return
    const gen = ++cafeGen
    // -i idle sleep  -s system sleep on AC. Do not pass -d: that would keep the display on.
    const child = spawn('/usr/bin/caffeinate', ['-i', '-s'], { stdio: 'ignore' })
    cafe = child
    child.on('error', (err) => {
      log(`stay-awake: caffeinate error: ${err.message}`)
      if (cafe === child) cafe = null
    })
    child.on('exit', (code, signal) => {
      log(`stay-awake: caffeinate exited code=${code} signal=${signal}`)
      if (cafe === child) cafe = null
      if (gen === cafeGen && holding()) startCaffeinate()
    })
    child.unref()
    log(`stay-awake: caffeinate -i -s pid=${child.pid}`)
  }

  function release() {
    cafeGen++
    if (blockerId != null) {
      try { if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId) } catch {}
      log(`stay-awake: off (released id=${blockerId})`)
      blockerId = null
    }
    if (cafe) {
      const child = cafe
      cafe = null
      try { child.kill('SIGTERM') } catch {}
    }
  }

  function sync() {
    if (holding()) acquire()
    else release()
    try { onChange() } catch {}
  }

  function setEnabled(v) {
    enabled = !!v
    if (!enabled) {
      displayOffHold = false
      release()
      try { onChange() } catch {}
    } else {
      sync()
    }
  }

  function clearDisplayHold({ force = false } = {}) {
    if (!displayOffHold) return
    if (!force && Date.now() < displayOffQuietUntil) return
    displayOffHold = false
    displayOffQuietUntil = 0
    log('stay-awake: display-off hold cleared')
    sync()
  }

  function sleepDisplay() {
    displayOffHold = true
    displayOffQuietUntil = Date.now() + 4000
    sync()
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        execFile('/usr/bin/pmset', ['displaysleep', 'now'], { timeout: 4000 }, (err) => {
          if (err) {
            log(`stay-awake: pmset displaysleep failed: ${err.message}`)
            // Display never slept, so unlock-screen / user-did-become-active may
            // never fire — drop the hold here or caffeinate stays on forever.
            clearDisplayHold({ force: true })
            reject(err)
            return
          }
          log('stay-awake: display sleep requested')
          resolve(true)
        })
      }, 180)
    })
  }

  function wirePowerMonitor() {
    if (wired) return
    if (!app.isReady()) {
      app.once('ready', wirePowerMonitor)
      return
    }
    wired = true
    powerMonitor.on('suspend', () => {
      log('stay-awake: system suspend (lid or Sleep) — Grok pauses until resume')
    })
    powerMonitor.on('resume', () => {
      log('stay-awake: system resume')
      if (holding()) acquire()
    })
    powerMonitor.on('lock-screen', () => {
      log('stay-awake: screen locked — work continues if held')
    })
    powerMonitor.on('unlock-screen', () => {
      log('stay-awake: screen unlocked')
      clearDisplayHold()
    })
    try {
      powerMonitor.on('user-did-become-active', () => {
        log('stay-awake: user became active')
        clearDisplayHold()
      })
    } catch {}
  }

  function stop() {
    enabled = false
    displayOffHold = false
    release()
  }

  function status() {
    return {
      enabled,
      holding: holding(),
      displayOffHold,
      blockerStarted: blockerId != null && powerSaveBlocker.isStarted(blockerId),
    }
  }

  wirePowerMonitor()

  return { setEnabled, sync, sleepDisplay, stop, status }
}
