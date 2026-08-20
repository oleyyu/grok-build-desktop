#!/usr/bin/env node
// initialize → notifications/initialized → tools/list → tools/call。

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'server.mjs')
const DO_SHOT = process.argv.includes('--shot')
const DO_MOVE = process.argv.includes('--move')

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', d => process.stderr.write('  [server] ' + d.toString().trim() + '\n'))

let buf = ''
const pending = new Map()
child.stdout.on('data', (c) => {
  buf += c.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch {
      fail(`服务器往 stdout 打了非 JSON：${line.slice(0, 120)}`)
      continue
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  }
})

let seq = 0
function req(method, params) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => { if (pending.delete(id)) reject(new Error('超时：' + method)) }, 30000)
  })
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

let passed = 0, failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
function fail(msg) { failed++; console.log('  ✗ ' + msg) }

const SERVER_KEY = 'computer'
function qualifiedOk(tool) {
  const q = `${SERVER_KEY}__${tool}`
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(q)) return `不合法：${q}`
  if ((q.match(/__/g) || []).length !== 1) return `'__' 出现 ${(q.match(/__/g) || []).length} 次：${q}`
  return null
}

console.log('\n── computer-use MCP 自测 ─────────────────────────────')

const t0 = Date.now()
const init = await req('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
  clientInfo: { name: 'grok-shell-computer', version: '1.0.5' },
})
const handshakeMs = Date.now() - t0

console.log('\n[1] 握手')
check('initialize 有响应', !!init.result, JSON.stringify(init).slice(0, 200))
check('回显 protocolVersion=2025-11-25', init.result?.protocolVersion === '2025-11-25',
  '实际 ' + init.result?.protocolVersion)
check('有 serverInfo.name', !!init.result?.serverInfo?.name)
check('有 capabilities', !!init.result?.capabilities)
check(`握手 <30s 启动超时（用时 ${handshakeMs}ms）`, handshakeMs < 30000)

notify('notifications/initialized')

console.log('\n[2] tools/list')
const list = await req('tools/list', {})
const tools = list.result?.tools || []
check('返回工具列表', tools.length > 0, `${tools.length} 个`)
check('无 nextCursor（单页）', !list.result?.nextCursor)
for (const t of tools) {
  const bad = qualifiedOk(t.name)
  check(`名字合法 ${SERVER_KEY}__${t.name}`, !bad, bad || '')
  check(`  ${t.name} 有 inputSchema.type=object`, t.inputSchema?.type === 'object')
  check(`  ${t.name} 有描述`, typeof t.description === 'string' && t.description.length > 5)
}
const names = tools.map(t => t.name)
for (const must of ['screenshot', 'left_click', 'type_text', 'press_key', 'scroll', 'drag'])
  check(`包含 ${must}`, names.includes(must))

console.log('\n[3] 只读工具')
const info = await req('tools/call', { name: 'get_screen_info', arguments: {} })
const infoTxt = info.result?.content?.[0]?.text || ''
check('get_screen_info 有响应', !!info.result)
let infoJson = null
try { infoJson = JSON.parse(infoTxt) } catch {}
const sr = infoJson?.permissions?.screenRecording
check('screenRecording 是真探测的 true/false/null', sr === true || sr === false || sr === null,
  '实际 ' + JSON.stringify(sr))
console.log('    ' + infoTxt.replace(/\n/g, '\n    '))

const w = await req('tools/call', { name: 'wait', arguments: { ms: 50 } })
check('wait 正常返回', w.result?.isError === false)

console.log('\n[4] 未知工具 / 未知方法 / 脏参数')
const bad = await req('tools/call', { name: 'no_such_tool', arguments: {} })
check('未知工具返回 isError:true（不是 JSON-RPC error）', bad.result?.isError === true)
const badm = await req('no/such/method', {})
check('未知方法返回 -32601', badm.error?.code === -32601)

for (const [label, args] of [
  ['NaN 坐标', { x: 'abc', y: 10 }],
  ['缺参数', {}],
  ['超大坐标', { x: 5e9, y: 5e9 }],
  ['Infinity', { x: Infinity, y: 0 }],
  ['null 坐标', { x: null, y: 10 }],
  ['空串坐标', { x: '', y: '   ' }],
  ['布尔坐标', { x: true, y: false }],
  ['数组坐标', { x: [], y: [] }],
]) {
  const r = await req('tools/call', { name: 'left_click', arguments: args })
  check(`left_click ${label} → 工具错误而非崩溃`, r.result?.isError === true,
    JSON.stringify(r).slice(0, 160))
}
const bigScroll = await req('tools/call', { name: 'scroll', arguments: { x: 10, y: 10, dy: 5e9 } })
check('scroll 超大 dy → 工具错误（不触发 Swift Int32 陷阱）', bigScroll.result?.isError === true)
const longType = await req('tools/call', { name: 'type_text', arguments: { text: 'a'.repeat(5000) } })
check('type_text 超长 → 工具错误（提示分批，不真去敲）', longType.result?.isError === true,
  (longType.result?.content?.[0]?.text || '').slice(0, 120))
const stillAlive = await req('tools/list', {})
check('脏参数之后服务器仍然活着', (stillAlive.result?.tools || []).length > 0)

if (DO_SHOT) {
  console.log('\n[5] 真截图')
  const s = await req('tools/call', { name: 'screenshot', arguments: {} })
  const c = s.result?.content || []
  const img = c.find(b => b.type === 'image')
  if (!img) {
    fail('没拿到 image block：' + (c.find(b => b.type === 'text')?.text || '').slice(0, 300))
  } else {
    const bytes = Buffer.from(img.data, 'base64').length
    const b64len = img.data.length
    check('isError 必须为 false（true 会让 grok 丢掉图片）', s.result?.isError === false)
    check('mimeType=image/png', img.mimeType === 'image/png')
    check(`base64 >1024 字符（小于此不抽取，${b64len}）`, b64len > 1024)
    check(`base64 <10MB 上限（${(b64len / 1048576).toFixed(2)}MB）`, b64len < 10 * 1024 * 1024)
    check(`原始字节 ≤1.5MB 免转码（${(bytes / 1048576).toFixed(2)}MB）`, bytes <= 1500000)
    const txt = c.find(b => b.type === 'text')?.text || ''
    check('文本里带 [shot:<id>] 预览标记', /\[shot:[0-9a-f]{16}\]/.test(txt), txt.slice(0, 200))
    console.log('    ' + txt)
  }
} else {
  console.log('\n[5] 真截图 —— 跳过（加 --shot 开启，需屏幕录制授权）')
}

if (DO_MOVE) {
  console.log('\n[6] 真移动鼠标')
  const m = await req('tools/call', { name: 'move_mouse', arguments: { x: 40, y: 40 } })
  check('move_mouse 成功', m.result?.isError === false,
    (m.result?.content?.[0]?.text || '').slice(0, 200))
} else {
  console.log('\n[6] 真移动鼠标 —— 跳过（加 --move 开启，需辅助功能授权）')
}

console.log(`\n───────────────────────────────────────────────────`)
console.log(`  通过 ${passed}，失败 ${failed}`)
child.stdin.end()
setTimeout(() => process.exit(failed ? 1 : 0), 200)
