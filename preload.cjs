// Isolated bridge: renderer gets this whitelist only, never Node.
const { contextBridge, ipcRenderer } = require('electron')

const INVOKE_CHANNELS = new Set([
  'engine:start', 'engine:stop', 'engine:info',
  'session:new', 'session:load', 'session:prompt', 'session:cancel',
  'queue:interject', 'queue:remove',
  'session:set-model', 'session:set-effort',
  'permission:respond', 'permission:set-mode',
  'sessions:list', 'sessions:delete',
  'presets:list',
  'settings:get', 'settings:set',
  'credentials:names', 'credentials:set',
  'workspace:pick', 'terminal:open',
  'stats:get',
  'account:get', 'account:logout', 'account:login-start',
  'account:info-live', 'account:subscription',
  'usage:get', 'usage:topup-rule',
  // computer-use:prewarm is required — settings calls it when enabling Computer Use.
  'computer-use:probe', 'computer-use:prewarm', 'computer-use:open-privacy', 'computer-use:read-shot',
  'app:open-data-dir', 'app:open-logs', 'app:open-readme', 'app:quit', 'app:version',
])

const EVENT_CHANNELS = new Set([
  'evt:session-update',
  'evt:engine-notification',
  'evt:permission-request',
  'evt:engine-exit',
  'evt:engine-ready',
  'evt:account-login-done',
])

contextBridge.exposeInMainWorld('grokDesktop', {
  invoke(channel, payload) {
    if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error(`未知频道: ${channel}`))
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel, callback) {
    if (!EVENT_CHANNELS.has(channel)) throw new Error(`未知事件频道: ${channel}`)
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
})
