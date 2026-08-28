'use strict'

const api = (channel, payload) => {
  if (!window.grokDesktop) return Promise.reject(new Error('bridge unavailable'))
  return window.grokDesktop.invoke(channel, payload)
}
const on = (channel, cb) => window.grokDesktop && window.grokDesktop.on(channel, cb)

const $ = (id) => document.getElementById(id)
function setGrokLoad(on) {
  const n = $('grokLoad')
  if (!n) return
  n.hidden = !on
}
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))

let toastTimer = null
function toast(msg) {
  const node = $('toast')
  node.textContent = msg
  node.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600)
}

marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    html(token) { return escapeHtml(token.raw ?? token.text ?? '') },
  },
})
function renderMd(node, md) {
  node.innerHTML = marked.parse(md)
  for (const a of node.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || ''
    if (!/^https?:|^mailto:/i.test(href)) a.removeAttribute('href')
  }
  for (const img of node.querySelectorAll('img')) {
    const src = img.getAttribute('src') || ''
    if (!/^data:image\//i.test(src)) img.removeAttribute('src')
  }
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]')
  if (a && /^https?:|^mailto:/i.test(a.href)) {
    e.preventDefault()
    window.open(a.href)
  }
})

const S = {
  settings: null,
  initInfo: null,
  models: [],
  currentModelId: null,
  currentEffort: null,
  engineRunning: false,
  sessions: [],
  presets: [],
  availableCommands: [],
  // initialize 只广播 9 个 shell builtin 里的 7 个；skill/workflow 要等 session/new 之后的
  // available_commands_update 才到。没到之前这份名单不是全集，未知命令拦截必须闭嘴。
  cmdsFresh: false,
  active: null,          // {sessionId, cwd, title, items:[], streaming}
  loadingSession: false,
  lastEventBySession: new Map(),
  queue: new Map(),      // sessionId -> {entries, runningPromptId}，_x.ai/queue/changed 每会话全量重建
  searchQuery: '',
  statsRange: 'all',
  lastUsage: null,
  lastUsageSid: null,
  ctxAt: 0,
  btwWatch: new Map(),
  pendingPerms: new Map(), // background sessions' permission requests, replayed on switch-in
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh']
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High' }
const PERM_LABELS = { 'ask': 'Ask every time', 'auto-safe': 'Auto-allow reads', 'always-approve': 'Full access' }

function currentModel() {
  return S.models.find((m) => m.modelId === S.currentModelId) || S.models[0] || null
}
function availableEfforts() {
  const m = currentModel()
  const list = m?._meta?.reasoningEfforts || []
  return EFFORT_ORDER.filter((id) => list.some((e) => e.id === id))
    .map((id) => list.find((e) => e.id === id))
}
function effectiveEffort() {
  const m = currentModel()
  const list = m?._meta?.reasoningEfforts || []
  if (S.currentEffort && (!list.length || list.some((e) => e.id === S.currentEffort))) return S.currentEffort
  return (list.find((e) => e.default) || list[0])?.id || 'high'
}
function modelDisplay(id) {
  const m = S.models.find((x) => x.modelId === id)
  return m?.name || id || '—'
}

// —— 落地页打字机：打完一句停一拍 → 逐字删掉 → 换下一句
// 首句固定 You're here!；后面把当前时段句和常规句洗在一起穿插，转完一圈再洗。过整点换池子。
// 时段：22:01–04:59 凌晨 / 05:00–08:59 清晨 / 09:00–11:59 工作时间 / 12:00–17:29 下午 / 17:30–22:00 晚上
const HERO_OPENER = 'You’re here!'
const HERO_COMMON = [
  'What are we building today?',
  'Ideas welcome. Weird ones too.',
  'Dream it. Type it. Run it.',
  'Half an idea is enough to start.',
  'Every big thing starts as one sentence.',
  'Press Enter and see what happens.',
  'Break things. We’ll fix them together.',
  'The cursor is waiting for you.',
  'Type the sentence. We’ll do the rest.',
  'Start anywhere. Anywhere works.',
  'The blank page is a dare.',
  'Small is a strategy.',
  'Run it. Then we’ll talk.',
  'One prompt is a start.',
  'Make a mess. That’s the job.',
  'If it compiles, it counts.',
]
const HERO_BY_PERIOD = {
  dawn: [
    'Morning’s quiet. Let’s use it.',
    'Rise and build.',
    'Fresh day. Fresh branch.',
    'Caffeine in, software out.',
    'Zero to app before your coffee cools.',
    'Stretch, sip, start.',
    'Before the world gets loud.',
    'First light, first commit.',
    'Easy. We’ll warm up together.',
    'The day’s still blank. Write something.',
    'Dawn’s a good time to start.',
    'Coffee’s hot. Keep the ideas hotter.',
    'Early hours, empty inbox, full possibility.',
    'The quiet morning is the productive one.',
    'Sun’s up. So is the cursor.',
    'Still sleepy. Still dangerous.',
    'Breakfast later. This first.',
    'Open the window. Then the editor.',
    'Don’t check chat yet.',
    'Cold start. We’ll get there.',
    'Morning playlist, blinking cursor.',
    'The 6am club is small. Hi.',
    'First tab of the day. Make it count.',
    'Alarm went off. So did the ideas.',
    'Outside’s still yawning.',
    'One quiet hour before the city.',
    'Start ugly. Morning doesn’t mind.',
    'Dew on the glass. Fire in the repo.',
    'Before the first meeting exists.',
    'Wake up. Warm up. Ship a little.',
  ],
  work: [
    'Today’s todo: make something cool.',
    'Ship something small today.',
    'Deep work window is open.',
    'Meetings later. Building now.',
    'One focused hour. That’s plenty.',
    'Inbox can wait. This can’t.',
    'Still morning. Plenty of runway.',
    'The thing you’ve been putting off — now.',
    'Peak hours. Use them.',
    'One more commit before lunch.',
    'Calendar’s loud. This box is quiet.',
    'Work mode: on.',
    'Stand-up’s over. Let’s stand something up.',
    'Focus while the day’s still sharp.',
    'Make the morning earn its coffee.',
    'Block two hours. Protect them.',
    'Slack can wait until noon.',
    'The real work hides between meetings.',
    'Morning’s the expensive hours. Spend them.',
    'Coffee number two. Go.',
    'If it ships before lunch, it counts twice.',
    'Mute the room. Unmute the idea.',
    'Status later. Progress now.',
    'Your best hour is happening.',
    'Make something the meeting can’t cancel.',
    'Close the extra tabs. Keep this one.',
    'Before noon, be selfish with time.',
    'The morning still has unused budget.',
    'Do the hard thing while it’s still morning.',
    'Inbox zero later. Idea one now.',
  ],
  afternoon: [
    'Afternoon. Second wind.',
    'Still time to make today count.',
    'That 3pm idea? Type it.',
    'Half the day left. The good half.',
    'Not too early, not too late.',
    'Build through the slump.',
    'Finish what you started this morning.',
    'Sun’s still up. So are we.',
    'A small ship before evening.',
    'Post-lunch. Pre-brilliant.',
    'Afternoon is underrated shipping time.',
    'You’re here, not scrolling. Good.',
    'The day’s half done. The fun part isn’t.',
    'Second coffee. Second chance.',
    'Let’s close a loop before dinner.',
    'Lunch was the intermission.',
    '2pm is a perfectly good time to start.',
    'Wrap one thing. Just one.',
    'Meetings ate the morning. Steal the afternoon.',
    'Walk it off, then ship it.',
    'The day’s not over. Don’t treat it like it is.',
    'Four o’clock courage. Use it.',
    'One more useful thing before 5:30.',
    'The inbox will refill. The idea won’t.',
    'If morning was messy, afternoon can still win.',
    'Stretch. Water. Then the hard part.',
    'The clock’s moving. So should the code.',
    'Post-lunch clarity is a tool. Use it.',
    'Leave the day with one thing finished.',
    'Sun’s sliding. Let’s not slide with it.',
  ],
  evening: [
    'Your side project misses you.',
    'Evening. No meetings. Just us.',
    'Side project o’clock.',
    'The world clocked out. We didn’t.',
    'After-hours energy hits different.',
    'Soft lighting. Sharp ideas.',
    'Tonight we ship.',
    'Night’s young. The repo’s younger.',
    'This is the quiet good part.',
    'Dinner’s done. The fun isn’t.',
    'After dark, the real work starts.',
    'No Slack. No stand-up. Just this.',
    'Evening is when the weird ideas land.',
    'Clock out of work. Clock in here.',
    'Off work. On to the good part.',
    'Work laptop closed. This one’s open.',
    'Dinner can wait five more minutes.',
    'Golden hour for the side project.',
    'The calendar went quiet. Finally.',
    'Home stretch. Make it yours.',
    'Evening’s just getting started.',
    'Off the clock. Still on the tools.',
    'Hoodie on. Notifications off.',
    'The show can wait. This is better.',
    'Weeknight energy, weekend ambition.',
    'Kitchen’s done. Cursor’s not.',
    '8pm is a perfectly serious hour.',
    'Friends cancelled. Lucky us.',
    'The day’s paid for. This part’s free.',
    'Pour the tea. Open the project.',
    'No boss. No backlog. Just want.',
    'Prime time, but for you.',
    'Evening treats the weird ideas kindly.',
    'Take the long way home — through here.',
  ],
  late: [
    'One more thing before bed.',
    'You should sleep. Or we ship. Fine.',
    '3am ideas hit different.',
    'The city’s asleep. The cursor isn’t.',
    'Late night. Low noise. High signal.',
    'Only the serious ones are still here.',
    'Insomnia, or inspiration?',
    'This hour belongs to the builders.',
    'Tomorrow-you can rest.',
    'Nobody’s watching. Be ambitious.',
    'Night shift of one.',
    'Sleep is a later problem.',
    'Weird hours make the good stuff.',
    'The world can wait until sunrise.',
    'If you’re up, we might as well build.',
    'Midnight oil, meet blinking cursor.',
    'It’s late. That’s the point.',
    'Ten o’clock. One more pass.',
    'Lights out except this screen.',
    'Tomorrow will forgive you.',
    'Last call for a small ship.',
    'Don’t start a huge thing. Or do.',
    'Past 10. The useful hours.',
    'Bed is a suggestion.',
    'Eleven pm. Still in the game.',
    'Midnight. No witnesses.',
    'The neighbors went to bed. We didn’t.',
    'Headphones on. World off.',
    'One more test, then maybe sleep.',
    'Tomorrow-morning-you will complain. Fine.',
    'Don’t open the timeline. Open this.',
    'Ship it, then sleep on it.',
    'The last train left. We’re still here.',
    'Quiet enough to hear the idea.',
    '2am is a feature, not a bug.',
    'If the house is dark, we’re doing it right.',
  ],
}
function heroPeriod(d = new Date()) {
  const m = d.getHours() * 60 + d.getMinutes()
  if (m >= 22 * 60 + 1 || m < 5 * 60) return 'late' // 22:01–04:59
  if (m < 9 * 60) return 'dawn'                      // 05:00–08:59
  if (m < 12 * 60) return 'work'                     // 09:00–11:59
  if (m < 17 * 60 + 30) return 'afternoon'           // 12:00–17:29
  return 'evening'                                   // 17:30–22:00
}
function shuffleHero(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}
function mixHeroLists(periodList, commonList) {
  const a = shuffleHero(periodList.slice())
  const b = shuffleHero(commonList.slice())
  const out = []
  let i = 0, j = 0
  const n = a.length, m = b.length
  while (i < n || j < m) {
    if (j >= m) { out.push(a[i++]); continue }
    if (i >= n) { out.push(b[j++]); continue }
    if (i * m <= j * n) out.push(a[i++])
    else out.push(b[j++])
  }
  return out
}
let heroMixPeriod = null
let heroMix = null
function currentHeroPhrases(reshuffle) {
  const period = heroPeriod()
  if (!reshuffle && heroMix && heroMixPeriod === period) return heroMix
  heroMixPeriod = period
  heroMix = [HERO_OPENER, ...mixHeroLists(HERO_BY_PERIOD[period] || [], HERO_COMMON)]
  return heroMix
}
let heroTyperOn = false
let heroWake = null
function heroParked() {
  return document.hidden || $('homeView').hidden // 不在落地页时挂起，省电也保新鲜感
}
function heroWaitUnparked() {
  if (!heroParked()) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      if (heroParked()) return
      document.removeEventListener('visibilitychange', done)
      if (heroWake === done) heroWake = null
      resolve()
    }
    heroWake = done
    document.addEventListener('visibilitychange', done)
  })
}
function heroMaybeUnpark() {
  if (heroWake) heroWake()
}
// 汉字一格≈两三个英文字母的信息量；按格等时打，中文整句会秒完。英文延迟不动。
// 全角/CJK 标点也按汉字计，不然「你来啦！」这种短句会被标点拖回英文本拍。
const HERO_CJK_SCALE = 2.8
function heroCjkUnit(ch) {
  if (/^\p{Script=Han}$/u.test(ch)) return true
  const c = ch.codePointAt(0)
  return (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)
}
function heroTypeMs(ch) {
  const ms = 50 + Math.random() * 65
  return heroCjkUnit(ch) ? ms * HERO_CJK_SCALE : ms
}
function heroDeleteMs(ch) {
  return heroCjkUnit(ch) ? Math.round(26 * HERO_CJK_SCALE) : 26
}
function startHeroTyper() {
  const node = $('heroTyped')
  const line = $('heroLine')
  if (!node || heroTyperOn) return
  heroTyperOn = true
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    node.textContent = t(HERO_OPENER)
    return
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function loop() {
    while (true) {
      const phrases = currentHeroPhrases(true)
      for (let i = 0; i < phrases.length; i++) {
        if (heroPeriod() !== heroMixPeriod) break
        const chars = Array.from(t(phrases[i]))
        line.classList.add('typing')
        for (let n = 1; n <= chars.length; n++) {
          if (heroParked()) await heroWaitUnparked()
          node.textContent = chars.slice(0, n).join('')
          await sleep(heroTypeMs(chars[n - 1]))
        }
        line.classList.remove('typing')
        await sleep(2500)
        line.classList.add('typing')
        for (let n = chars.length - 1; n >= 0; n--) {
          if (heroParked()) await heroWaitUnparked()
          node.textContent = chars.slice(0, n).join('')
          await sleep(heroDeleteMs(chars[n]))
        }
        line.classList.remove('typing')
        await sleep(450)
      }
    }
  }
  loop()
}

function showHome() {
  navEpoch++ // 回落地页也是一次导航：作废还在飞的建会话/恢复
  S.active = null
  stashLivePerms() // sessions keep running in background; re-shown on switch-in
  $('permArea').innerHTML = ''
  $('homeView').hidden = false
  heroMaybeUnpark()
  $('chatView').hidden = true
  $('homeCenter').append($('composerWrap'))
  $('ctxChips').hidden = false
  renderSessionList()
  refreshSendState()
  renderQueueRow() // 队列条只跟当前会话走；回落地页时藏起来
  ppSync() // 计划栏同理
}
function showChat() {
  $('homeView').hidden = true
  $('chatView').hidden = false
  document.querySelector('.main').insertBefore($('composerWrap'), null)
  $('ctxChips').hidden = true
  ppSync()
}

const tInner = $('tInner')
const transcript = $('transcript')
let nearBottom = true
transcript.addEventListener('scroll', () => {
  nearBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 90
})
function scrollDown(force) {
  if (force || nearBottom) transcript.scrollTop = transcript.scrollHeight
}

let mdFlushQueued = false
const mdDirty = new Set()
function queueMdFlush() {
  if (mdFlushQueued) return
  mdFlushQueued = true
  requestAnimationFrame(() => {
    mdFlushQueued = false
    for (const item of mdDirty) {
      if (item.mdNode) renderMd(item.mdNode, itemVisibleText(item))
    }
    mdDirty.clear()
    scrollDown(false)
  })
}

function clearTranscript() {
  tInner.innerHTML = ''
  if (S.active) S.active.items = []
}
function lastItem() {
  const items = S.active?.items
  return items && items.length ? items[items.length - 1] : null
}
function pushItem(item, sess) {
  const owner = sess || S.active
  owner.items.push(item)
  if (owner !== S.active) return item // 后台会话的本地条目：切回来会整段重放，不上屏
  const ts = document.getElementById('turnStatus')
  if (ts && ts.parentNode === tInner) tInner.insertBefore(item.el, ts)
  else tInner.append(item.el)
  scrollDown(false)
  return item
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}
function fmtWhen(ts) {
  if (!ts) return ''
  const d = Date.now() - ts
  const zh = I18N.lang === 'zh'
  if (d < 60e3) return t('just now')
  if (d < 3600e3) return `${Math.floor(d / 60e3)}${zh ? '分钟' : 'm'}`
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}${zh ? '小时' : 'h'}`
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)}${zh ? '天' : 'd'}`
  const dt = new Date(ts)
  return `${dt.getMonth() + 1}/${dt.getDate()}`
}

const fmtClock = (ts) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function newUserItem(promptIndex, sess) {
  const wrap = el('div', 'msg msg-user')
  const bubble = el('div', 'bubble')
  wrap.append(el('span', 'msg-ts', fmtClock(Date.now())), bubble)
  return pushItem({ kind: 'user', text: '', promptIndex, el: wrap, bodyNode: bubble }, sess)
}

function newAssistantItem() {
  // No hover Copy row (user cut it 2026-08-20): its invisible placeholder ate a
  // full line of vertical space under every reply. /copy and /export still work.
  const wrap = el('div')
  const msg = el('div', 'msg msg-assistant')
  const md = el('div', 'md')
  msg.append(md)
  wrap.append(el('div', 'msg-ts', fmtClock(Date.now())), msg)
  return pushItem({ kind: 'assistant', text: '', el: wrap, mdNode: md })
}

function newThoughtItem() {
  const wrap = el('div')
  const line = el('div', 'thought-line')
  const pulse = el('span', 'pulse')
  const label = el('span', null, t('Thinking…'))
  line.append(pulse, label)
  const body = el('div', 'thought-body')
  body.style.display = 'none'
  wrap.append(line, body)
  const item = pushItem({
    kind: 'thought', text: '', el: wrap, bodyNode: body, labelNode: label, pulseNode: pulse,
    startedAt: Date.now(), done: false, open: false,
  })
  line.addEventListener('click', () => {
    item.open = !item.open
    body.style.display = item.open ? '' : 'none'
    if (item.open) { body.textContent = item.text; scrollDown(false) }
  })
  return item
}

function finishThought(item) {
  if (!item || item.done) return
  item.done = true
  if (S.settings?.ui?.keepThoughts) {
    item.labelNode.textContent = `${t('Thought for')} ${fmtDur(Date.now() - item.startedAt)}`
    item.pulseNode?.remove()
  } else {
    item.el.remove()
    item.removed = true
  }
}
function finishAllThoughts() {
  for (const it of S.active?.items || []) if (it.kind === 'thought') finishThought(it)
}

const TOOL_KIND_LABELS = {
  execute: 'Run', read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move',
  search: 'Search', fetch: 'Web', think: 'Think', other: 'Tool',
}
function newToolItem(update) {
  const wrap = el('div', 'tool-card')
  const head = el('div', 'tool-head')
  const kindTag = el('span', 'k')
  const title = el('span', 't')
  const status = el('span', 'st st-run', '⋯')
  head.append(kindTag, title, status)
  const out = el('div', 'tool-out')
  out.style.display = 'none'
  const shot = el('div', 'tool-shot')
  shot.style.display = 'none'
  wrap.append(head, shot, out)
  const item = pushItem({
    kind: 'tool', el: wrap, toolCallId: update.toolCallId,
    kindNode: kindTag, titleNode: title, statusNode: status, outNode: out, shotNode: shot,
    open: false, output: '', title: '', toolKind: '',
  })
  head.addEventListener('click', () => {
    item.open = !item.open
    out.style.display = item.open ? '' : 'none'
    if (item.open) { renderToolOut(item); scrollDown(false) }
  })
  applyToolUpdate(item, update)
  maybeGroupItem(item)
  return item
}

function renderToolOut(item) {
  const out = item.outNode
  if (item.diffData && (item.diffData.oldS || item.diffData.newS)) {
    out.classList.add('diff')
    out.innerHTML = ''
    if (item.diffData.oldS) {
      for (const ln of String(item.diffData.oldS).split('\n')) out.append(el('div', 'dl del', '- ' + ln))
    }
    if (item.diffData.newS) {
      for (const ln of String(item.diffData.newS).split('\n')) out.append(el('div', 'dl add', '+ ' + ln))
    }
    return
  }
  out.classList.remove('diff')
  const body = item.output || t('(no output yet)')
  out.textContent = item.cmdText ? `$ ${item.cmdText}\n\n${body}` : body
}

function groupTypeOf(item) {
  if (item.kind !== 'tool') return null
  if (item.shotSrc || item.shotPending || item.shotNode?.childElementCount) return null
  if (item.agentKind) return 'misc'
  if (item.toolKind === 'execute') return 'cmd'
  if (item.diffData) return 'edit'
  return 'misc'
}
function toolRunLabel(g) {
  const by = { cmd: [], edit: [], misc: [] }
  for (const i of g.items) by[groupTypeOf(i) || 'misc'].push(i)
  const parts = []
  if (by.cmd.length) parts.push(by.cmd.length === 1 ? t('Ran 1 command') : t('Ran {0} commands', by.cmd.length))
  if (by.edit.length) {
    const files = new Set(by.edit.map((i) => i.diffData?.path || i.toolCallId))
    parts.push(files.size === 1 ? t('Edited 1 file') : t('Edited {0} files', files.size))
  }
  if (by.misc.length) {
    const n = by.misc.length
    parts.push(by.misc.every((i) => i.toolKind === 'read')
      ? (n === 1 ? t('Read 1 file') : t('Read {0} files', n))
      : (n === 1 ? t('Used 1 tool') : t('Used {0} tools', n)))
  }
  return parts.join(t(', '))
}
function makeToolGroup(anchorEl) {
  const wrap = el('div', 'cmd-group')
  const head = el('div', 'cg-head')
  const chev = el('span', 'chev', '›')
  const label = el('span', 'lbl', '')
  const gst = el('span', 'gst st-run', '⋯')
  head.append(chev, label, gst)
  const list = el('div', 'cg-list')
  list.hidden = true
  wrap.append(head, list)
  const group = { el: wrap, listEl: list, labelEl: label, gstEl: gst, chevEl: chev, items: [], open: false }
  head.addEventListener('click', () => {
    group.open = !group.open
    group.listEl.hidden = !group.open
    group.chevEl.textContent = group.open ? '⌄' : '›'
    if (group.open) scrollDown(false)
  })
  anchorEl.parentNode.insertBefore(wrap, anchorEl)
  return group
}
function maybeGroupItem(item) {
  if (!S.active) return
  const type = groupTypeOf(item)
  if (!type) return
  item.el.classList.remove('gt-cmd', 'gt-edit', 'gt-misc')
  item.el.classList.add(`gt-${type}`)
  let g = item.toolGroup
  if (!g) {
    const items = S.active.items || []
    if (items[items.length - 1] !== item) return
    let prev = null
    for (let i = items.length - 2; i >= 0; i--) {
      if (items[i].kind === 'thought') continue
      prev = items[i]
      break
    }
    g = S.active.toolRunGroup
    const contiguous = g && prev && g.items[g.items.length - 1] === prev
    if (!contiguous) {
      g = makeToolGroup(item.el)
      S.active.toolRunGroup = g
    }
    g.listEl.append(item.el)
    g.items.push(item)
    item.toolGroup = g
  }
  g.labelEl.textContent = toolRunLabel(g)
  const running = g.items.some((i) => i.statusNode.classList.contains('st-run'))
  const failed = g.items.some((i) => i.statusNode.classList.contains('st-fail'))
  g.gstEl.textContent = running ? '⋯' : failed ? '✗' : '✓'
  g.gstEl.className = 'gst ' + (running ? 'st-run' : failed ? 'st-fail' : 'st-ok')
}

function applyToolUpdate(item, u) {
  if (u.kind) item.toolKind = u.kind
  const meta = u._meta?.['x.ai/tool']
  if (!item.toolKind && meta?.kind) item.toolKind = meta.kind
  item.kindNode.textContent = t(TOOL_KIND_LABELS[item.toolKind] || TOOL_KIND_LABELS.other)

  if (u.title) item.title = u.title
  else if (!item.title && u.rawInput?.command) item.title = u.rawInput.command
  else if (!item.title) item.title = meta?.label || meta?.name || 'tool'
  item.titleNode.textContent = item.title

  if (item.toolKind === 'execute') {
    if (u.rawInput?.command) item.cmdText = String(u.rawInput.command)
    if (u.rawInput?.description) item.cmdDesc = String(u.rawInput.description)
    const line = item.cmdDesc || (item.cmdText || item.title || '').split('\n')[0]
    if (line) item.titleNode.textContent = line
  }

  const rawIn = u.rawInput || {}
  const mk = String(meta?.kind || '').toLowerCase()
  if ((mk === 'edit' || mk === 'write' || item.toolKind === 'edit')
      && (rawIn.file_path || rawIn.filePath || meta?.input?.path || item.diffData)) {
    const path = rawIn.file_path || rawIn.filePath || meta?.input?.path || item.diffData?.path || ''
    const oldS = rawIn.old_string ?? rawIn.oldString ?? item.diffData?.oldS ?? ''
    const newS = rawIn.new_string ?? rawIn.newString ?? rawIn.content ?? item.diffData?.newS ?? ''
    const isWrite = mk === 'write' || rawIn.content != null
    item.diffData = { path, oldS, newS }
    item.el.classList.add('edit-card')
    const base = String(path).split('/').pop() || path
    item.titleNode.textContent = `${t(isWrite ? 'Wrote' : 'Edited')} ${base}`
    const del = oldS ? String(oldS).split('\n').length : 0
    const add = newS ? String(newS).split('\n').length : 0
    if (!item.dsNode) {
      item.dsNode = el('span', 'ds')
      item.titleNode.after(item.dsNode)
    }
    item.dsNode.innerHTML = ''
    if (add) item.dsNode.append(el('i', 'add', `+${add}`))
    if (del) item.dsNode.append(el('i', 'del', `-${del}`))
  }

  const mKind = String(meta?.kind || '').toLowerCase()
  const mName = String(meta?.name || '').toLowerCase()
  if (mKind === 'task' || mKind === 'workflow' || mName === 'task' || mName === 'spawn_subagent' || mName === 'workflow') {
    if (!item.agentKind) {
      item.agentKind = (mKind === 'workflow' || mName === 'workflow') ? 'workflow' : 'task'
      item.el.classList.add('agent-task')
      item.kindNode.textContent = '⚙'
    }
    const label = item.agentKind === 'workflow' ? t('Started a workflow') : t('Started a subagent')
    const desc = tsClamp(u.rawInput?.description || meta?.input?.description || u.rawInput?.prompt || '')
    item.titleNode.textContent = desc ? `${label} — ${desc}` : label
  }

  if (u.status === 'completed') {
    item.statusNode.textContent = '✓'
    item.statusNode.className = 'st st-ok'
  } else if (u.status === 'failed') {
    item.statusNode.textContent = '✗'
    item.statusNode.className = 'st st-fail'
  }

  const ro = u.rawOutput
  if (ro && typeof ro.output_for_prompt === 'string') {
    item.output = ro.output_for_prompt
    if (ro.exit_code != null && ro.exit_code !== 0) item.output += `\n[exit ${ro.exit_code}]`
  } else if (Array.isArray(u.content)) {
    const texts = u.content.map((c) => c?.content?.text ?? '').filter(Boolean)
    if (texts.length) item.output = texts.join('\n')
  } else if (ro && ro.type === 'MCP') {
    const o = ro.output
    const text = typeof o === 'string' ? o : (o?.OkayOutput ?? o?.Error ?? '')
    if (text) item.output = String(text)
  }
  maybeRenderShot(item)
  item.output = stripShotTag(item.output)
  maybeGroupItem(item)
  if (item.open) renderToolOut(item)
}

const SHOT_TAG = /\[shot:([0-9a-f]{16})\]/
function maybeRenderShot(item) {
  if (item.shotSrc || item.shotPending || !item.shotNode) return
  const m = SHOT_TAG.exec(typeof item.output === 'string' ? item.output : '')
  if (!m) return
  item.shotPending = true
  api('computer-use:read-shot', { id: m[1] }).then((src) => {
    if (!src) return
    item.shotSrc = src
    const img = el('img')
    img.src = src
    img.alt = t('Screenshot')
    item.shotNode.innerHTML = ''
    item.shotNode.append(img)
    item.shotNode.style.display = ''
    img.addEventListener('load', () => scrollDown(false), { once: true })
  }).catch(() => {}).finally(() => { item.shotPending = false })
}

function stripShotTag(s) {
  return typeof s === 'string' ? s.replace(SHOT_TAG, '').replace(/[ \t]+$/gm, '') : s
}

// grok 把技能列表 / MCP 状态 / 后台任务完成等塞进对话。TUI 不进滚动区；桌面端以前当用户气泡。
// 判定顺序：chunk hideFromScrollback → promptId 来源（notifications-/workflow-completed-…）
// → 已知系统唤醒正文（workflow 完成那句没有 <system-reminder> 包装）→ 标签前缀。
const SYS_REMINDER_BLOCK = /<system[-_]reminder\b[^>]*>[\s\S]*?<\/system[-_]reminder\s*>/gi
const SYS_REMINDER_OPEN = /<system[-_]reminder\b/i
const HIDDEN_PROMPT_PREFIXES = [
  'task-completed-',
  'subagent-completed-',
  'workflow-completed-',
  'notifications-',
  'goal-summary-',
  'goal-classifier-nudge-',
]
function chunkMeta(u) {
  return u?._meta || u?.meta || null
}
function isHiddenPromptId(pid) {
  if (!pid) return false
  return HIDDEN_PROMPT_PREFIXES.some((p) => String(pid).startsWith(p))
}
function isSystemReminderPayload(text) {
  const s = String(text || '')
  const t = s.trimStart()
  if (/^<system[-_]reminder[\s>]/i.test(t)) return true
  if (/^<monitor-event\b/i.test(t)) return true
  if (t === '---') return true
  // WorkflowCompleted / NotificationDrain 注入：模型指令，不是用户打的字。
  if (/^A background workflow (stopped|finished)\b/i.test(t)) return true
  const first = t.split('\n', 1)[0] || ''
  return /^\d/.test(first) && first.includes(' monitor events from ') && first.includes(' (use ')
}
function isHiddenUserChunk(u, text, params) {
  const meta = chunkMeta(u)
  if (meta?.hideFromScrollback) return true
  const pi = meta?.promptIndex
  if (pi != null && S.active?.hiddenPromptIdx?.has(pi)) return true
  const pid = params?._meta?.promptId || meta?.promptId
  if (isHiddenPromptId(pid)) return true
  return isSystemReminderPayload(text)
}
function hideIncompleteReminder(s) {
  const lt = s.lastIndexOf('<')
  if (lt < 0) return s
  const tail = s.slice(lt).toLowerCase()
  if (tail.includes('>') || tail.length < 2) return s
  if ('<system-reminder'.startsWith(tail) || '<system_reminder'.startsWith(tail)) return s.slice(0, lt)
  return s
}
function stripSystemReminders(text) {
  if (typeof text !== 'string' || !text) return text || ''
  if (text.indexOf('<') < 0) return text
  let out = text.replace(SYS_REMINDER_BLOCK, '')
  const unclosed = SYS_REMINDER_OPEN.exec(out)
  if (unclosed) out = out.slice(0, unclosed.index)
  else out = hideIncompleteReminder(out)
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
}
function itemVisibleText(it) {
  if (!it) return ''
  if (it.displayText != null) return it.displayText
  if (it.kind === 'assistant') return stripSystemReminders(it.text || '')
  return it.text || ''
}

function infoLine(text, isErr) {
  if (!S.active) return
  pushItem({ kind: 'info', el: el('div', 'info-line' + (isErr ? ' err' : ''), text) })
}

function handleUpdate(params) {
  const u = params.update || {}
  const k = u.sessionUpdate
  if (k === 'available_commands_update') {
    S.availableCommands = u.availableCommands || []
    S.cmdsFresh = true
    return
  }
  if (params.sessionId) S.lastEventBySession.set(params.sessionId, Date.now())
  if (k === 'turn_completed') {
    onTurnCompleted(params.sessionId, u, params)
    return
  }
  const btw = S.btwWatch.get(params.sessionId)
  if (btw) { btw(u); return }
  if (!S.active || params.sessionId !== S.active.sessionId) return
  // session/load 回放期间禁止把本地 echo 当成吸收器，否则会吞掉历史 user chunk。
  if (S.loadingSession && S.active.echoAbsorb) S.active.echoAbsorb = null
  const tt = params._meta?.totalTokens
  if (typeof tt === 'number' && tt > 0) {
    TS.tokens = tt
    if (S.active.ctxTokens !== tt) {
      S.active.ctxTokens = tt
      S.ctxAt = Date.now()
      updateUsageRing()
    }
  }

  if (k !== 'user_message_chunk' && S.active.echoAbsorb) S.active.echoAbsorb = null

  if (k === 'user_message_chunk') {
    const text = u.content?.text ?? ''
    const pi = chunkMeta(u)?.promptIndex
    const hidden = isHiddenUserChunk(u, text, params)
    if (hidden && pi != null) {
      if (!S.active.hiddenPromptIdx) S.active.hiddenPromptIdx = new Set()
      S.active.hiddenPromptIdx.add(pi)
    }
    if (S.active.echoAbsorb) {
      const ea = S.active.echoAbsorb
      // 隐藏注入（后台任务完成等）不是用户回显，不能吞进 echoAbsorb。
      if (!hidden && (pi == null || ea.promptIndex == null || ea.promptIndex === pi)) {
        if (pi != null) ea.promptIndex = pi
        return
      }
      if (pi != null && ea.promptIndex != null && ea.promptIndex !== pi) S.active.echoAbsorb = null
    }
    // 没被本地回显吸收的 user chunk = 队列 drain / 插队开跑的新回合（或 goal 注入）。
    // 把生成态钉到新回合上：换代 epoch —— 旧回合 send() 的 finally 从此无权收尾。
    // session/load 回放（loadingSession / isReplay）除外；已是队列回合在流式中也不用重复激活。
    if (!S.loadingSession && !params._meta?.isReplay) {
      const sid = S.active.sessionId
      if (TS.cancelling && TS.sessionId === sid) {
        // Stop 之后 grok 若把排队的下一条立刻开跑，不要 tsBegin 把「正在停止」冲掉。
        if (!TS.reCancelArmed) {
          TS.reCancelArmed = true
          api('session:cancel', { sessionId: sid }).catch(() => {})
        }
      } else {
        const cur = sendingSessions.get(sid)
        const queueOwned = cur != null && queueTurnEpochs.has(cur)
        if (!(queueOwned && S.active.streaming)) {
          if (queueOwned) queueTurnEpochs.delete(cur)
          const epoch = ++sendEpoch
          sendingSessions.set(sid, epoch)
          queueTurnEpochs.add(epoch)
          S.active.streaming = true
          tsBegin(sid)
          refreshSendState()
        }
      }
    }
    if (hidden) return
    const last = lastItem()
    if (last?.kind === 'user' && (pi == null || last.promptIndex === pi)) {
      last.text += text
      last.bodyNode.textContent = last.text
    } else {
      const item = newUserItem(pi)
      item.text = text
      item.bodyNode.textContent = text
    }
    scrollDown(false)
  } else if (k === 'agent_thought_chunk') {
    tsSet('thinking', t('Thinking…'))
    if (TS.visible) {
      TS.thoughtText += u.content?.text ?? ''
      if (TS.thoughtOpen) tsThoughtRender()
    }
    if (S.settings?.ui?.keepThoughts) {
      let last = lastItem()
      if (!(last?.kind === 'thought' && !last.done)) last = newThoughtItem()
      last.text += u.content?.text ?? ''
      if (last.open) { last.bodyNode.textContent = last.text; scrollDown(false) }
    }
  } else if (k === 'agent_message_chunk') {
    tsSet('responding', t('Responding…'))
    finishAllThoughts()
    let last = lastItem()
    if (last?.kind !== 'assistant' || last.isPlan) last = newAssistantItem()
    last.text += u.content?.text ?? ''
    last.displayText = stripSystemReminders(last.text)
    last.el.hidden = !last.displayText.trim()
    if (last.el.hidden) return
    mdDirty.add(last)
    queueMdFlush()
  } else if (k === 'tool_call') {
    finishAllThoughts()
    tsOnTool(newToolItem(u), u)
  } else if (k === 'tool_call_update') {
    let item = (S.active.items || []).find((i) => i.kind === 'tool' && i.toolCallId === u.toolCallId)
    if (item) applyToolUpdate(item, u)
    else item = newToolItem(u)
    tsOnTool(item, u)
    scrollDown(false)
  } else if (k === 'session_info_update') {
    if (u.title) {
      S.active.title = u.title
      $('headTitle').textContent = u.title
      const s = S.sessions.find((x) => x.id === S.active.sessionId)
      if (s) { s.title = u.title; renderSessionList() }
    }
  } else if (k === 'plan') {
    tsSet('plan', t('Updating todo list…'))
    // 计划不进对话流：存到会话上，渲染进右侧计划栏（历史回放时同样走这里重建）
    S.active.plan = u.entries || []
    ppSync()
  }
}

function displayTitle(s) {
  return (s && s.title) || t('New session')
}

function setChatHeader() {
  $('headTitle').textContent = displayTitle(S.active)
  const chip = $('headCwd')
  if (S.active?.cwd) {
    chip.hidden = false
    chip.textContent = folderName(S.active.cwd)
    chip.title = S.active.cwd
  } else chip.hidden = true
}

function folderName(p) {
  if (!p) return ''
  return p.split('/').pop() || p
}

function rememberCwd(cwd) {
  if (!cwd || !S.settings) return
  if (!S.settings.workspace) S.settings.workspace = { lastCwd: null, recentCwds: [] }
  const ws = S.settings.workspace
  ws.lastCwd = cwd
  const rec = Array.isArray(ws.recentCwds) ? ws.recentCwds : []
  ws.recentCwds = [cwd, ...rec.filter((p) => p !== cwd)].slice(0, 12)
  api('settings:set', { workspace: { lastCwd: cwd, recentCwds: ws.recentCwds } }).catch(() => {})
  updateMeta()
}

function recentWorkspaceList() {
  const seen = new Set()
  const out = []
  const push = (p) => {
    if (typeof p !== 'string' || !p || seen.has(p)) return
    seen.add(p)
    out.push(p)
  }
  push(S.settings?.workspace?.lastCwd)
  for (const p of S.settings?.workspace?.recentCwds || []) push(p)
  for (const s of S.sessions || []) push(s.cwd)
  return out.slice(0, 8)
}

async function pickFolderViaDialog() {
  const cwd = await api('workspace:pick')
  if (!cwd) return null
  rememberCwd(cwd)
  if (S.active && cwd !== S.active.cwd) toast(t('Working directory updated for new sessions'))
  return cwd
}

function applyWorkspaceCwd(cwd) {
  if (!cwd) return
  rememberCwd(cwd)
  if (S.active && cwd !== S.active.cwd) toast(t('Working directory updated for new sessions'))
}

function openCwdMenu() {
  const recents = recentWorkspaceList()
  if (!recents.length) { pickFolderViaDialog(); return }
  const current = S.active?.cwd || S.settings?.workspace?.lastCwd
  const items = [{ heading: t('Recent') }]
  for (const p of recents) {
    items.push({
      label: folderName(p),
      title: p,
      selected: p === current,
      onPick: () => applyWorkspaceCwd(p),
    })
  }
  items.push({ sep: true }, {
    label: t('Open folder…'),
    onPick: () => { pickFolderViaDialog() },
  })
  showPopover($('cwdChip'), items, { above: true })
}

async function ensureCwd() {
  let cwd = S.active?.cwd || S.settings?.workspace?.lastCwd
  if (!cwd) cwd = await pickFolderViaDialog()
  return cwd
}

// 导航代际：'+' 与会话行连点时，晚回来的 RPC 不许清掉先赢者的视图
let navEpoch = 0
async function startNewSession(cwdOverride) {
  const cwd = cwdOverride || await ensureCwd()
  if (!cwd) { toast(t('Pick a working directory first')); return null }
  const myNav = ++navEpoch // 接管视图：作废还在飞的 openSession
  const presetId = S.settings?.presets?.default || null
  S.active = null
  rememberCwd(cwd)
  showChat()
  stashLivePerms() // 旧会话没答复的审批卡收走，别压在新聊天底下被误点（openSession 同款纪律）
  $('permArea').innerHTML = ''
  $('headTitle').textContent = t('New session')
  const chip = $('headCwd')
  chip.hidden = false
  chip.textContent = folderName(cwd)
  chip.title = cwd
  tInner.innerHTML = ''
  try {
    const r = await api('session:new', { cwd, presetId })
    if (myNav !== navEpoch) return null // 用户已导航去别处：这次建会话作废，别覆盖人家的 S.active
    S.active = { sessionId: r.sessionId, cwd, title: t('New session'), items: [], streaming: false }
    clearTranscript()
    setChatHeader()
    renderQueueRow()
    drainPendingPerms(r.sessionId)
    refreshSessionsSoon()
    const al = r?._alignment
    if (al && (!al.modelOk || !al.effortOk)) {
      if (!al.modelOk && al.actualModel) {
        S.currentModelId = al.actualModel
        updateMeta()
      }
      toast(t('Model/effort alignment failed — this session runs engine defaults'))
    }
    return S.active
  } catch (err) {
    if (myNav !== navEpoch) return null // 已过时的失败：视图早易主，静默丢弃
    showHome()
    toast(`${t('Create session failed')}: ${err.message}`)
    return null
  }
}

async function openSession(sess) {
  if (S.loadingSession) { toast(t('Restoring session…')); return }
  const myNav = ++navEpoch // 与 startNewSession 互斥：后到的导航作废先前那个
  S.loadingSession = true
  S.active = { sessionId: sess.id, cwd: sess.cwd, title: displayTitle(sess), items: [], streaming: false }
  clearTranscript()
  setChatHeader()
  showChat()
  renderSessionList()
  refreshSendState()
  renderQueueRow() // 只显示本会话的排队条
  stashLivePerms() // keep unanswered cards; they re-appear when their session is active
  $('permArea').innerHTML = ''
  drainPendingPerms(sess.id)
  setGrokLoad(true)
  try {
    await api('session:load', {
      sessionId: sess.id, cwd: sess.cwd,
      presetId: S.settings?.presets?.default || null,
    })
    if (myNav !== navEpoch) return // 视图已易主：别再动人家的转录
    finishAllThoughts()
    scrollDown(true)
  } catch (err) {
    if (myNav !== navEpoch) return
    infoLine(`${t('Restore failed')}: ${err.message}`, true)
  } finally {
    finishAllThoughts()
    S.loadingSession = false
    if (myNav === navEpoch) setGrokLoad(false)
    updateUsageRing()
  }
}

// In-flight turns tracked PER SESSION — parallel sessions all working at once
// (the engine/ACP always supported it; /btw side chat proved it). The old global
// single lock made "one session generating" block sends in every other session.
// SEND_PENDING marks a turn whose session isn't created yet (there's only one
// composer, so at most one of those exists at a time).
// Map: sessionId -> 回合代际（epoch）。队列 drain 出的新回合会「顶掉」旧回合的代际，
// 旧回合的 finally 据此失去收尾权（否则它的 tsEnd/解锁会误杀新回合的生成态）。
const sendingSessions = new Map()
let sendEpoch = 0
const queueTurnEpochs = new Set() // 由队列 drain 激活（而非 send() 认领）的代际
const SEND_PENDING = '__pending__'
const ATT = { list: [] } // [{mimeType, data(base64), src(dataURI)}]
const MAX_ATTACHMENTS = 4
function renderAttachRow() {
  const row = $('attachRow')
  row.innerHTML = ''
  row.hidden = ATT.list.length === 0
  ATT.list.forEach((a, i) => {
    const chip = el('span', 'att-chip')
    const img = el('img')
    img.src = a.src
    const x = el('button', 'att-x', '✕')
    x.title = t('Remove image')
    x.addEventListener('click', () => { ATT.list.splice(i, 1); renderAttachRow() })
    chip.append(img, x)
    row.append(chip)
  })
}
function addAttachment(file) {
  if (ATT.list.length >= MAX_ATTACHMENTS) { toast(t('Up to 4 images per message')); return }
  const reader = new FileReader()
  reader.onload = () => {
    const m = /^data:([^;]+);base64,(.+)$/.exec(String(reader.result))
    if (!m) return
    if (ATT.list.length >= MAX_ATTACHMENTS) { toast(t('Up to 4 images per message')); return }
    if (m[2].length >= 16e6) { toast(t('Image is too large')); return }
    ATT.list.push({ mimeType: m[1], data: m[2], src: String(reader.result) })
    renderAttachRow()
  }
  reader.readAsDataURL(file)
}
$('input').addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || []
  let got = false
  for (const it of items) {
    if (it.kind === 'file' && /^image\//.test(it.type || '')) {
      const f = it.getAsFile()
      if (f) { addAttachment(f); got = true }
    }
  }
  if (got) e.preventDefault()
})

// session:load 会把整段历史当 session/update 事件重放回来 —— 恢复必须走全套纪律：
// 清屏 + 挂 loadingSession，否则转录翻倍，回放的 user_message_chunk 还会误触发
// 激活块，造出一个停不掉的幽灵回合（永转的 spinner、点不动的停止键）
let restoreChain = Promise.resolve()
async function restoreActiveSession(sess) {
  const job = restoreChain.then(
    () => restoreActiveSessionBody(sess),
    () => restoreActiveSessionBody(sess),
  )
  restoreChain = job.then(() => {}, () => {})
  return job
}
async function restoreActiveSessionBody(sess) {
  sess = sess || S.active
  if (!sess) return true
  // 引擎重启后残留的队列代际必是幽灵（真队列回合已随旧进程死了）：当场收尾
  const cur = sendingSessions.get(sess.sessionId)
  if (cur != null && queueTurnEpochs.has(cur)) {
    sendingSessions.delete(sess.sessionId)
    queueTurnEpochs.delete(cur)
    sess.streaming = false
    if (TS.sessionId === sess.sessionId) tsEnd()
    refreshSendState()
  }
  const tookView = S.active === sess // 目标不在前台就只回灌引擎，回放事件自会被丢弃
  if (tookView) {
    S.loadingSession = true
    clearTranscript()
    setGrokLoad(true)
  }
  try {
    await api('session:load', {
      sessionId: sess.sessionId,
      cwd: sess.cwd,
      presetId: S.settings?.presets?.default || null,
    })
    if (S.active === sess) {
      finishAllThoughts()
      scrollDown(true)
    }
    return true
  } catch (e) {
    toast(`${t('Restore failed')}: ${e.message}`)
    return false
  } finally {
    if (tookView) {
      S.loadingSession = false
      setGrokLoad(false)
    }
  }
}

function turnInfo(sessionId, text, isErr) {
  if (S.active?.sessionId === sessionId) infoLine(text, isErr)
  else toast(text)
}

async function send() {
  const input = $('input')
  let text = input.value.trim()
  if (!text && !ATT.list.length) return
  if (text.startsWith('/')) {
    input.value = ''
    autoGrow()
    if (popoverFor === input) closePopover()
    const routed = handleSlash(text)
    if (routed.handled) {
      if (routed.restore) { input.value = text; autoGrow() } // 拦下来的未知命令：别把人打的字弄丢
      return
    }
    text = routed.text // 别名/裸 skill 名已改写成引擎认识的写法
    input.value = text
  }
  if (S.loadingSession) {
    toast(t('Restoring session…'))
    return
  }
  // 只锁「当前这个会话」：别的会话在生成不拦着这里发（多会话并行干活）
  // 目标会话进门时定格成快照：后面每个 await 期间用户都可能切走，消息只认它
  let target = S.active
  let lockKey = target?.sessionId || SEND_PENDING
  if (sendingSessions.has(lockKey)) {
    // 回合进行中再发 → 走 grok 原生 prompt 队列（引擎侧排队，回合结束自动接跑；
    // TUI 同款：Enter 排队，空输入框再按一次 Enter 对队首插队）
    if (lockKey === SEND_PENDING) { toast(t('This session is still generating — wait or stop it first')); return }
    const attachments = ATT.list.map(({ mimeType, data }) => ({ mimeType, data }))
    ATT.list = []
    renderAttachRow()
    input.value = ''
    autoGrow()
    queueSend(lockKey, text, attachments)
    return
  }
  const myEpoch = ++sendEpoch
  sendingSessions.set(lockKey, myEpoch)
  setSendState(true)
  tsBegin(target?.sessionId || null)
  input.value = ''
  autoGrow()
  const attachSaved = ATT.list.slice()
  const giveBack = () => {
    input.value = text
    autoGrow()
    if (attachSaved.length && !ATT.list.length) { ATT.list = attachSaved.slice(); renderAttachRow() }
  }
  // catch reads these; 'use strict' makes a try-block const a ReferenceError.
  let sessionId = target?.sessionId
  let attachments
  try {
    if (!S.engineRunning) {
      toast(t('Starting engine…'))
      try {
        await api('engine:start', {})
        setEngineState(true)
      } catch (err) {
        toast(`${t('Engine failed to start')}: ${err.message}`)
        giveBack()
        return
      }
      if (!(await restoreActiveSession(target))) { giveBack(); return }
    }
    if (!target) {
      target = await startNewSession()
      if (!target) { giveBack(); return }
      // 会话刚建出来：占位锁换成真身份（代际随行）—— 只有 SEND_PENDING 这条路允许换绑
      sendingSessions.delete(lockKey)
      lockKey = target.sessionId
      sendingSessions.set(lockKey, myEpoch)
      syncSessionWorkingMarks()
    }
    TS.sessionId = target.sessionId
    target.streaming = true
    attachments = ATT.list.map(({ mimeType, data }) => ({ mimeType, data }))
    const attachSrcs = ATT.list.map((a) => a.src)
    ATT.list = []
    renderAttachRow()
    const localUser = newUserItem(null, target)
    localUser.text = text
    localUser.bodyNode.textContent = text
    for (const src of attachSrcs) {
      const img = el('img', 'echo-img')
      img.src = src
      localUser.bodyNode.append(img)
    }
    target.echoAbsorb = localUser
    if (S.active === target) scrollDown(true)
    sessionId = target.sessionId
    const promptStartedAt = Date.now()
    let stallTimer = null
    const stallGuard = new Promise((resolve) => {
      stallTimer = setInterval(() => {
        if ((S.lastEventBySession.get(sessionId) || 0) >= promptStartedAt) {
          clearInterval(stallTimer)
          return
        }
        if (Date.now() - promptStartedAt > 150e3) resolve({ __stalled: true })
      }, 5000)
    })
    let r
    try {
      r = await Promise.race([api('session:prompt', { sessionId, text, attachments }), stallGuard])
    } finally {
      clearInterval(stallTimer)
    }
    if (r?.__stalled) {
      requestCancel(sessionId)
      turnInfo(sessionId, t('No response from the engine for 150s — this turn was stopped. Just send again.'), true)
    } else {
      applyPromptResult(r, sessionId)
      if (r?._localAbort) {
        turnInfo(sessionId, t('Stop did not finish — the turn was released locally. If Grok keeps going, press Stop again or restart the engine.'), true)
      }
    }
  } catch (err) {
    if (isAccountSwitchedErr(err) && target) {
      await handleAccountSwitchRetry(err, target, sessionId, text, attachments, giveBack)
    } else if (isSessionNotLoadedErr(err) && target) {
      if (await restoreActiveSession(target)) {
        try {
          const r2 = await api('session:prompt', { sessionId, text, attachments })
          applyPromptResult(r2, sessionId)
        } catch (err2) {
          turnInfo(sessionId, `${t('Error')}: ${err2.message}`, true)
          giveBack()
        }
      } else giveBack()
    } else {
      turnInfo(target?.sessionId || lockKey, `${t('Error')}: ${err.message}`, true)
      giveBack()
    }
  } finally {
    // 代际校验：本回合结束前若队列已 drain 出新回合（epoch 被顶掉），收尾权已易主
    if (sendingSessions.get(lockKey) === myEpoch) {
      sendingSessions.delete(lockKey)
      const wd = cancelWatchdogs.get(lockKey)
      if (wd) { clearTimeout(wd); cancelWatchdogs.delete(lockKey) }
      if (target) target.streaming = false
      if (S.active?.sessionId === lockKey) {
        S.active.streaming = false
        finishAllThoughts() // 只收自己会话的思考行，别动别的在飞回合
      }
      // 状态行是单例、跟着最近一个回合走：还归本回合（或本回合到死都没建出会话）才收
      if (TS.sessionId === lockKey || (lockKey === SEND_PENDING && TS.sessionId === null)) tsEnd()
    }
    refreshSendState() // 发送键/引擎灯按「当前会话是否在生成 + 是否还有在飞回合」重算
    refreshSessionsSoon()
  }
}

function isAccountSwitchedErr(err) {
  return /^ACCOUNT_SWITCHED:/.test(err?.message || '')
}
function isSessionNotLoadedErr(err) {
  return err?.message === 'SESSION_NOT_LOADED'
}
function applyPromptResult(r, sessionId) {
  if (!r) return
  if (r._meta) {
    S.lastUsage = r._meta
    S.lastUsageSid = sessionId
    S.ctxAt = Date.now()
    if (typeof r._meta.totalTokens === 'number' && S.active?.sessionId === sessionId) {
      S.active.ctxTokens = r._meta.totalTokens
    }
    updateUsageRing()
  }
  if (r.stopReason && r.stopReason !== 'end_turn' && r.stopReason !== 'cancelled') {
    turnInfo(sessionId, `${t('Turn ended')}: ${r.stopReason}`)
  }
}
async function handleAccountSwitchRetry(err, target, sessionId, text, attachments, giveBack) {
  resetAfterAccountChange()
  prefetchAccount(true).catch(() => {})
  prefetchUsage(true, { deep: true }).catch(() => {})
  if (!(await restoreActiveSession(target))) { giveBack?.(); return }
  try {
    const r = await api('session:prompt', { sessionId, text, attachments })
    applyPromptResult(r, sessionId)
  } catch (err2) {
    turnInfo(sessionId, `${t('Error')}: ${err2.message}`, true)
    giveBack?.()
  }
}

function fmtTokens(n) {
  if (n == null) return '0'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
function fmtBig(n) {
  if (n == null) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
function fmtHeatNum(n) {
  return fmtBig(n).replace(/\.0(?=[kMB])/, '')
}
function fmtHeatDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const loc = I18N.lang === 'zh' ? 'zh-CN' : 'en-US'
  return new Date(y, m - 1, d).toLocaleDateString(loc, { month: 'short', day: 'numeric' })
}

let heatTipEl = null
function hideHeatTip() {
  if (heatTipEl) heatTipEl.classList.remove('on')
}
function showHeatTip(anchor, text) {
  if (!heatTipEl || !heatTipEl.isConnected) {
    heatTipEl = el('div', 'ta-tip')
    heatTipEl.setAttribute('role', 'tooltip')
    document.body.append(heatTipEl)
    if (!showHeatTip._scroll) {
      document.addEventListener('scroll', hideHeatTip, true)
      showHeatTip._scroll = true
    }
  }
  heatTipEl.textContent = text
  const r = anchor.getBoundingClientRect()
  const half = (heatTipEl.offsetWidth || 0) / 2
  const padX = 10
  const left = Math.max(half + padX, Math.min(window.innerWidth - half - padX, r.left + r.width / 2))
  heatTipEl.style.left = `${left}px`
  heatTipEl.style.top = `${r.top}px`
  heatTipEl.classList.add('on')
}
function bindHeatTip(node, text) {
  node.addEventListener('mouseenter', () => showHeatTip(node, text))
  node.addEventListener('mouseleave', hideHeatTip)
  node.setAttribute('aria-label', text)
}

function setSendState(streaming) {
  const btn = $('btnSend')
  if (streaming) {
    btn.textContent = '■'
    btn.classList.add('stop')
    btn.title = t('Stop generating')
  } else {
    btn.textContent = '↑'
    btn.classList.remove('stop')
    btn.title = t('Send')
  }
  const dot = $('engineDot')
  // 引擎灯亮 = 任何会话有在飞回合（不只当前这个）
  dot.classList.toggle('busy', streaming || sendingSessions.size > 0)
  syncSessionWorkingMarks()
}

function refreshSendState() {
  setSendState(!!S.active && sendingSessions.has(S.active.sessionId))
  tsReconcile()
  tsBeatSync()
}

// 状态行（Thinking…/Running…）是单例，靠 tsBegin/tsEnd 显式驱动；而「这个会话还在不在生成」
// 的真相是 sendingSessions —— 发送键用的同一个。两者一旦走岔，用户看到的就是
// 「停止键还亮着，底下的 Thinking… 却没了」：队列 drain 出来的回合没有 send() 守生命周期、
// session/load 恢复会先收尾、切会话时状态行被摘掉之后没人再挂回去，都会岔开。
// 与其逐条补，不如每次状态变化按真相对一次账。
function tsReconcile() {
  const sid = S.active?.sessionId
  if (!sid) return
  if (sendingSessions.has(sid)) {
    // 没挂，或还挂在别的会话上（状态行是单例）：改挂到用户正在看的这个会话
    if (!TS.visible || TS.sessionId !== sid) tsBegin(sid)
  } else if (TS.visible && TS.sessionId === sid) {
    tsEnd() // 反向：回合早收了，状态行还杵着转圈
  }
}

// ---------- 排队与插队（grok 原生 prompt 队列，TUI 同款交互；真机 probe 实锤） ----------
// 回合进行中 Enter：session/prompt 照发 —— 引擎自己排队并广播 _x.ai/queue/changed，
// 当前回合结束自动接跑；这条 RPC 要等到它自己的回合完成才回来。
// 空输入框再按一次 Enter：对队首发 _x.ai/queue/interject（send-now）——
// 引擎取消当前回合（旧 RPC 以 stopReason=cancelled 收尾，本 UI 对 cancelled 静默）
// 并立刻用这条消息开新回合，模型马上读到。goal 回合则合并进当前回合，不取消。
async function queueSend(sessionId, text, attachments) {
  try {
    const r = await api('session:prompt', { sessionId, text, attachments })
    applyPromptResult(r, sessionId)
  } catch (err) {
    if (isAccountSwitchedErr(err) || isSessionNotLoadedErr(err)) {
      const listed = S.sessions.find((s) => s.id === sessionId)
      const sess = (S.active?.sessionId === sessionId)
        ? S.active
        : (listed ? { sessionId, cwd: listed.cwd } : null)
      if (sess?.cwd && isAccountSwitchedErr(err)) {
        await handleAccountSwitchRetry(err, sess, sessionId, text, attachments, null)
      } else if (sess?.cwd && isSessionNotLoadedErr(err)) {
        if (await restoreActiveSession(sess)) {
          try {
            const r2 = await api('session:prompt', { sessionId, text, attachments })
            applyPromptResult(r2, sessionId)
          } catch (err2) {
            turnInfo(sessionId, `${t('Queued message failed')}: ${err2.message}`, true)
          }
        }
      } else turnInfo(sessionId, `${t('Queued message failed')}: ${err.message}`, true)
    } else {
      turnInfo(sessionId, `${t('Queued message failed')}: ${err.message}`, true)
    }
  } finally {
    maybeEndQueuedTurnUI(sessionId)
    refreshSessionsSoon()
  }
}

function queueHasWork(sessionId) {
  const q = S.queue.get(sessionId)
  return !!(q && (q.runningPromptId || q.entries.length))
}

// 队列 drain 出来的回合没有 send() 守生命周期，收尾走这里：
// 生成态确实归队列回合所有（epoch ∈ queueTurnEpochs）且引擎队列已空转才收。
function maybeEndQueuedTurnUI(sessionId) {
  const epoch = sendingSessions.get(sessionId)
  if (epoch == null || !queueTurnEpochs.has(epoch)) return
  if (queueHasWork(sessionId)) return
  sendingSessions.delete(sessionId)
  queueTurnEpochs.delete(epoch)
  const wd = cancelWatchdogs.get(sessionId)
  if (wd) { clearTimeout(wd); cancelWatchdogs.delete(sessionId) }
  if (S.active?.sessionId === sessionId) {
    S.active.streaming = false
    finishAllThoughts()
  }
  if (TS.sessionId === sessionId) tsEnd()
  refreshSendState()
}

// 引擎走 `_x.ai/session/update` 发 durable TurnCompleted。普通用户回合还有 session/prompt
// RPC 的 finally 收尾；workflow/notification drain 是引擎自己塞进队列的隐藏回合，
// 没有对应的 session:prompt，而且结束时不广播 queue/changed（queue_meta 为空），
// 若不在这里收，状态行会永远停在 Responding…。
function onTurnCompleted(sessionId, u, envelope) {
  if (!sessionId || S.loadingSession || envelope?._meta?.isReplay) return
  const pid = u?.prompt_id || u?.promptId
  const q = S.queue.get(sessionId)
  if (q && q.runningPromptId) {
    // 隐藏唤醒回合结束时不广播 queue/changed，runningPromptId 会钉死 queueHasWork。
    // 只清「就是这一轮」或「两端都是合成 prompt」——别误清用户已经开跑的下一轮。
    if (!pid || q.runningPromptId === pid
        || (isHiddenPromptId(pid) && isHiddenPromptId(q.runningPromptId))) {
      q.runningPromptId = null
    }
  }
  maybeEndQueuedTurnUI(sessionId)
  const usage = u?.usage
  applyPromptResult({
    stopReason: u?.stop_reason || u?.stopReason,
    _meta: usage && typeof usage === 'object' ? usage : undefined,
  }, sessionId)
}

function interjectTop(sessionId) {
  const q = S.queue.get(sessionId)
  if (!q || !q.entries.length) return
  const top = q.entries[0]
  api('queue:interject', { sessionId, id: top.id, expectedVersion: top.version || 0 })
    .catch((err) => toast(err.message))
}

function renderQueueRow() {
  const host = $('queueRow')
  const sid = S.active?.sessionId
  const q = sid ? S.queue.get(sid) : null
  const show = !!(q && q.entries.length)
  host.hidden = !show
  host.innerHTML = ''
  if (!show) return
  q.entries.forEach((en, i) => {
    const row = el('div', 'q-item')
    const txt = el('span', 'q-text', en.text || '')
    txt.title = en.text || ''
    const now = el('button', 'q-btn', '↑')
    now.title = t('Send now (jump the queue)')
    now.addEventListener('click', () => {
      api('queue:interject', { sessionId: sid, id: en.id, expectedVersion: en.version || 0 })
        .catch((err) => toast(err.message))
    })
    const rm = el('button', 'q-btn', '✕')
    rm.title = t('Remove from queue')
    rm.addEventListener('click', () => {
      api('queue:remove', { sessionId: sid, id: en.id, expectedVersion: en.version || 0 })
        .catch((err) => toast(err.message))
    })
    row.append(el('span', 'q-pos', String(i + 1)), txt, now, rm)
    host.append(row)
  })
  host.append(el('div', 'q-hint', t('Queued — runs after this turn. Press Enter on an empty box to send the top one now.')))
}

const TS = {
  visible: false, key: null, labelText: '', cls: '',
  turnStartedAt: 0, timer: null, tokens: 0,
  thoughtText: '', thoughtOpen: false,
  runningTools: new Map(), cancelling: false, reCancelArmed: false,
  sessionId: null,
}

function tsFmtTurn(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}
function tsClamp(s) {
  const line = String(s || '').split('\n')[0]
  return line.length > 48 ? line.slice(0, 48) + '…' : line
}

const tsEl = $('turnStatus')
const tsLabelEl = $('tsLabel')
const tsTurnEl = $('tsTurn')
const tsThoughtEl = el('div', 'ts-thought')

function tsRender() {
  if (TS.sessionId && TS.sessionId !== S.active?.sessionId) {
    tsEl.remove()
    tsThoughtEl.remove()
    return
  }
  if (tsEl.parentNode !== tInner || tsEl.nextSibling) {
    tInner.append(tsEl)
    scrollDown(false)
  }
  if (TS.thoughtOpen && (tsThoughtEl.parentNode !== tInner || tsThoughtEl.nextSibling !== tsEl)) {
    tInner.insertBefore(tsThoughtEl, tsEl)
  }
  tsLabelEl.textContent = TS.labelText
  const turnText = tsFmtTurn(Date.now() - TS.turnStartedAt)
    + (TS.tokens > 0 ? ` · ${fmtBig(TS.tokens)} tokens` : '')
  if (tsTurnEl.textContent !== turnText) tsTurnEl.textContent = turnText
  tsEl.classList.toggle('tool', TS.cls === 'tool')
  tsEl.classList.toggle('cancel', TS.cls === 'cancel')
  const expandable = !!TS.thoughtText && !S.settings?.ui?.keepThoughts
  tsEl.classList.toggle('has-thought', expandable)
  tsEl.title = expandable ? t('Click to show thinking') : ''
}

tsEl.addEventListener('click', () => {
  if (!TS.visible || !TS.thoughtText || S.settings?.ui?.keepThoughts) return
  TS.thoughtOpen = !TS.thoughtOpen
  if (TS.thoughtOpen) {
    tsThoughtRender()
  } else {
    tsThoughtEl.remove()
  }
  tsRender()
})
function tsThoughtRender() {
  if (!TS.thoughtOpen) return
  tsThoughtEl.textContent = TS.thoughtText
  if (tsThoughtEl.parentNode !== tInner) tInner.insertBefore(tsThoughtEl, tsEl)
  scrollDown(false)
}

function tsSet(key, labelText, cls) {
  if (!TS.visible) return
  if (TS.cancelling && cls !== 'cancel') return
  const nextCls = cls || ''
  if (TS.key === key && TS.labelText === labelText && TS.cls === nextCls) return
  TS.key = key
  TS.labelText = labelText
  TS.cls = nextCls
  tsRender()
}

function tsBegin(sessionId) {
  TS.visible = true
  TS.sessionId = sessionId ?? S.active?.sessionId ?? null
  TS.cancelling = false
  TS.reCancelArmed = false
  TS.runningTools.clear()
  TS.turnStartedAt = Date.now()
  TS.key = null
  TS.tokens = 0
  TS.thoughtText = ''
  TS.thoughtOpen = false
  tsThoughtEl.remove()
  tsEl.hidden = false
  tsSet('waiting', t('Waiting for Grok…'))
  tsArmClock()
  tsBeatSync()
}

function tsArmClock() {
  clearInterval(TS.timer)
  TS.timer = null
  // Elapsed-seconds text only. The spinner is CSS, so 1 Hz is enough and
  // avoids a 133ms innerText/layout loop while a turn is running.
  if (!TS.visible || document.hidden) return
  TS.timer = setInterval(() => { if (TS.visible) tsRender() }, 1000)
}

// TS.timer 只在状态行可见时跑，救不了「该显示却没显示」；对账要有个独立心跳兜底，
// 免得某条新路径忘了调 refreshSendState 就又变成一直没有 Thinking…
// 闲置时不要 1 Hz 空转：只在有在飞回合或状态行挂着时才拍。
let tsBeat = null
function tsBeatWanted() {
  return !document.hidden && (sendingSessions.size > 0 || TS.visible)
}
function tsBeatSync() {
  if (tsBeatWanted()) {
    if (!tsBeat) tsBeat = setInterval(tsReconcile, 1000)
  } else if (tsBeat) {
    clearInterval(tsBeat)
    tsBeat = null
  }
}
document.addEventListener('visibilitychange', () => {
  tsArmClock()
  tsBeatSync()
  if (!document.hidden) tsReconcile()
})

function tsEnd() {
  TS.visible = false
  TS.sessionId = null
  TS.cancelling = false
  TS.reCancelArmed = false
  TS.runningTools.clear()
  clearInterval(TS.timer)
  TS.timer = null
  TS.thoughtOpen = false
  tsThoughtEl.remove()
  tsEl.hidden = true
  tsEl.remove()
  tsBeatSync()
}

function tsCancelling() {
  if (!TS.visible) return
  TS.cancelling = true
  TS.reCancelArmed = false
  TS.cls = 'cancel'
  tsSet('cancelling', t('Cancelling…'), 'cancel')
}

function forceEndTurn(sessionId) {
  const epoch = sendingSessions.get(sessionId)
  if (epoch != null) {
    sendingSessions.delete(sessionId)
    queueTurnEpochs.delete(epoch)
  }
  if (S.active?.sessionId === sessionId) {
    S.active.streaming = false
    finishAllThoughts()
  }
  if (TS.sessionId === sessionId) tsEnd()
  refreshSendState()
}

function dismissPermsFor(sessionId) {
  for (const [key, req] of [...livePerms]) {
    if (req.sessionId !== sessionId) continue
    livePerms.delete(key)
    api('permission:respond', { key, optionId: null }).catch(() => {})
  }
  for (const card of [...permArea.children]) {
    if (card.dataset.sid === sessionId) card.remove()
  }
  S.pendingPerms.delete(sessionId)
}

const cancelWatchdogs = new Map()
function armCancelWatchdog(sessionId) {
  const prev = cancelWatchdogs.get(sessionId)
  if (prev) clearTimeout(prev)
  // Engine aborts the prompt RPC at 15s. This is a UI backstop if IPC never returns.
  const timer = setTimeout(() => {
    cancelWatchdogs.delete(sessionId)
    if (!sendingSessions.has(sessionId)) return
    turnInfo(sessionId, t('Stop did not finish — the turn was released locally. If Grok keeps going, press Stop again or restart the engine.'), true)
    forceEndTurn(sessionId)
  }, 20000)
  cancelWatchdogs.set(sessionId, timer)
}

function requestCancel(sessionId) {
  if (!sessionId) return
  if (TS.sessionId === sessionId) tsCancelling()
  dismissPermsFor(sessionId)
  S.queue.delete(sessionId)
  renderQueueRow()
  armCancelWatchdog(sessionId)
  api('session:cancel', { sessionId }).catch(() => forceEndTurn(sessionId))
  for (const r of WF.runs.values()) {
    if (r.status !== 'active' && r.status !== 'paused') continue
    if (r.sessionId && r.sessionId !== sessionId) continue
    const agentIds = (r.agents || []).map((a) => a.agent_id).filter(Boolean)
    api('workflow:stop', { sessionId: r.sessionId || sessionId, runId: r.run_id, name: r.name, agentIds }).catch(() => {})
  }
}

function tsApplyTool(id, rec) {
  if (rec.agent) {
    tsSet('tool:' + id, rec.agent === 'workflow' ? t('Running a workflow…') : t('Running a subagent…'))
    return
  }
  const desc = (rec.desc || '').trim()
  if (desc) tsSet('tool:' + id, tsClamp(desc) + '…')
  else tsSet('tool:' + id, `${t('Running')}: ${tsClamp(rec.title || 'tool')}`, 'tool')
}
function tsOnTool(item, u) {
  if (!TS.visible || !item) return
  const id = item.toolCallId || 'tool'
  const rec = TS.runningTools.get(id) || {}
  if (item.agentKind) rec.agent = item.agentKind
  if (u?.rawInput?.description) rec.desc = String(u.rawInput.description)
  if (item.title) rec.title = item.title
  if (u?.status === 'completed' || u?.status === 'failed') {
    TS.runningTools.delete(id)
    if (TS.key === 'tool:' + id) {
      const rest = [...TS.runningTools.entries()]
      if (rest.length) tsApplyTool(rest[rest.length - 1][0], rest[rest.length - 1][1])
      else tsSet('waiting', t('Waiting for Grok…'))
    }
    return
  }
  TS.runningTools.set(id, rec)
  tsApplyTool(id, rec)
}

$('btnSend').addEventListener('click', () => {
  if (S.active && sendingSessions.has(S.active.sessionId)) {
    requestCancel(S.active.sessionId)
  } else {
    send()
  }
})

const inputEl = $('input')
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    const swap = !!S.settings?.ui?.multiline
    if (swap ? e.shiftKey : !e.shiftKey) {
      e.preventDefault()
      // 空输入框 + 本会话生成中 + 有排队 → 二次 Enter 对队首插队（TUI 的 empty-Enter send-now）
      const sid = S.active?.sessionId
      if (sid && sendingSessions.has(sid) && !inputEl.value.trim() && !ATT.list.length
        && S.queue.get(sid)?.entries.length) {
        interjectTop(sid)
        return
      }
      send()
    }
  }
})
function autoGrow() {
  inputEl.style.height = 'auto'
  inputEl.style.height = Math.min(inputEl.scrollHeight, 260) + 'px'
}
inputEl.addEventListener('input', () => {
  autoGrow()
  maybeShowSlashMenu()
})

const BUILTIN_COMMANDS = [
  { name: 'quit', aliases: ['exit'], desc: 'Quit the application', kind: 'act' },
  { name: 'help', aliases: [], desc: 'Browse commands and keyboard shortcuts', kind: 'act' },
  { name: 'docs', aliases: ['howto', 'guides'], desc: 'Copy the Build docs URL (docs.x.ai)', kind: 'act' },
  { name: 'home', aliases: ['welcome'], desc: 'Return to the welcome screen', kind: 'act' },
  { name: 'delete', aliases: [], desc: 'Delete this session', kind: 'act' },
  { name: 'new', aliases: [], desc: 'Start a new session', kind: 'act' },
  { name: 'clear', aliases: [], desc: 'Clear this chat (fresh session; the old record is deleted)', kind: 'act' },
  { name: 'fork', aliases: [], desc: 'Branch the current session into a peer agent', kind: 'tui' },
  { name: 'compact', aliases: [], desc: 'Compact conversation history', kind: 'pass' },
  { name: 'copy', aliases: [], desc: 'Copy last response to clipboard', kind: 'act' },
  { name: 'find', aliases: [], desc: 'Search the conversation scrollback', kind: 'act' },
  { name: 'history', aliases: [], desc: 'Search prompt history', kind: 'act' },
  { name: 'export', aliases: [], desc: 'Copy the whole conversation as Markdown', kind: 'act' },
  { name: 'transcript', aliases: ['log'], desc: 'Copy the whole conversation as Markdown', kind: 'act' },
  { name: 'edit-prompt', aliases: [], desc: 'Open an external editor for the prompt', kind: 'act' },
  { name: 'expand', aliases: [], desc: 'Re-print the last collapsed block (minimal mode)', kind: 'tui' },
  // local: 引擎也叫这个名字，但 ACP 侧只吞不吐（实测零事件）——本地实现必须压过它
  { name: 'context', aliases: [], desc: 'View context usage', kind: 'act', local: true },
  { name: 'minimal', aliases: [], desc: 'Reopen in minimal (scrollback-native) mode', kind: 'tui' },
  { name: 'fullscreen', aliases: ['full'], desc: 'Reopen in fullscreen mode', kind: 'tui' },
  { name: 'model', aliases: ['m'], desc: 'Switch the active model', kind: 'act' },
  { name: 'effort', aliases: [], desc: 'Set reasoning effort for the current model', kind: 'act' },
  { name: 'always-approve', aliases: [], desc: 'Toggle always-approve mode (skip all permission prompts)', kind: 'act', local: true },
  { name: 'auto', aliases: [], desc: 'Toggle auto mode (auto-allow read-only tools)', kind: 'act' },
  { name: 'multiline', aliases: ['ml'], desc: 'Toggle multiline input mode (swap Enter and Shift+Enter)', kind: 'act' },
  { name: 'compact-mode', aliases: [], desc: 'Toggle compact UI (less padding, more content)', kind: 'act' },
  { name: 'display-off', aliases: ['sleep-display', 'blank-screen'], desc: 'Turn the display off; Grok keeps working', kind: 'act' },
  { name: 'vim-mode', aliases: [], desc: 'Toggle vim-style scrollback keybindings', kind: 'tui' },
  { name: 'hooks', aliases: ['hooks-list', 'hooks-trust', 'hooks-add', 'hooks-remove', 'hooks-untrust'], desc: 'View hooks', kind: 'tui' },
  { name: 'plugins', aliases: [], desc: 'View plugins', kind: 'tui' },
  { name: 'marketplace', aliases: [], desc: 'View marketplace', kind: 'tui' },
  { name: 'skills', aliases: [], desc: 'View skills', kind: 'tui' },
  { name: 'share', aliases: [], desc: 'Share this session via URL', kind: 'tui' },
  { name: 'session-info', aliases: ['status', 'info'], desc: 'Show session info', kind: 'act' },
  { name: 'rename', aliases: ['title'], desc: 'Rename the current session', kind: 'tui' },
  { name: 'dashboard', aliases: ['agents-dashboard', 'sessions'], desc: 'Fullscreen overview of every running session', kind: 'tui' },
  { name: 'cd', aliases: [], desc: 'Change the working directory for new sessions', kind: 'act' },
  { name: 'theme', aliases: ['t'], desc: 'Switch the color theme', kind: 'act' },
  // 引擎认（session/new 之后才进 availableCommands）——pass 让首个会话建立前也走对路
  { name: 'feedback', aliases: [], desc: 'Send feedback about the current session', kind: 'pass' },
  { name: 'announcements', aliases: [], desc: 'Show or hide announcements', kind: 'tui' },
  { name: 'remember', aliases: [], desc: 'Save a memory note', kind: 'tui' },
  { name: 'memory', aliases: ['mem'], desc: 'Browse and manage saved memories', kind: 'tui' },
  { name: 'flush', aliases: [], desc: 'Save this session’s knowledge to memory now', kind: 'tui' },
  { name: 'dream', aliases: [], desc: 'Run memory consolidation', kind: 'tui' },
  { name: 'plan', aliases: [], desc: 'Enter plan mode', kind: 'tui' },
  { name: 'view-plan', aliases: ['show-plan', 'plan-view'], desc: 'View the current plan', kind: 'act' },
  { name: 'resume', aliases: [], desc: 'Resume a previous session', kind: 'act' },
  { name: 'mcps', aliases: [], desc: 'Show MCP server status', kind: 'tui' },
  { name: 'workflows', aliases: [], desc: 'Show workflow runs (phases, agents, progress)', kind: 'act' },
  { name: 'btw', aliases: [], desc: 'Ask a side question without interrupting', kind: 'act' },
  { name: 'doctor', aliases: ['terminal-setup', 'terminal-check', 'terminal-info'], desc: 'Check this session and show available fixes', kind: 'tui' },
  { name: 'voice', aliases: [], desc: 'Dictation (use macOS dictation in the input)', kind: 'act' },
  { name: 'loop', aliases: [], desc: 'Run a prompt on a recurring interval', kind: 'pass' },
  // 引擎把它挂成限定名 bundled:imagine；handleSlash 会自动改写，改写不到才提示去 TUI
  { name: 'imagine', aliases: [], desc: 'Generate an image from a text description', kind: 'tui' },
  { name: 'imagine-video', aliases: [], desc: 'Generate a video from a text description', kind: 'tui' },
  { name: 'timestamps', aliases: [], desc: 'Toggle message timestamps', kind: 'act' },
  { name: 'timeline', aliases: [], desc: 'Toggle the timeline sidebar', kind: 'tui' },
  { name: 'toggle-mouse-reporting', aliases: [], desc: 'Toggle terminal mouse reporting', kind: 'tui' },
  { name: 'settings', aliases: ['config', 'preferences', 'prefs'], desc: 'Open the settings modal', kind: 'act' },
  { name: 'privacy', aliases: [], desc: 'Open coding data, retention, and training settings', kind: 'act' },
  { name: 'rewind', aliases: ['undo'], desc: 'Rewind to a previous turn', kind: 'tui' },
  { name: 'jump', aliases: [], desc: 'Jump to a turn in the conversation', kind: 'act' },
  { name: 'login', aliases: [], desc: 'Log in or re-authenticate with your account', kind: 'act' },
  { name: 'logout', aliases: [], desc: 'Log out and return to the login screen', kind: 'act' },
  { name: 'import-claude', aliases: [], desc: 'Open the Claude settings import modal', kind: 'tui' },
  { name: 'usage', aliases: ['cost'], desc: 'View usage', kind: 'act' },
  { name: 'queue', aliases: [], desc: 'List the prompts queued behind the running turn', kind: 'act' },
  { name: 'tasks', aliases: [], desc: 'List background tasks, subagents, and scheduled tasks', kind: 'act' },
  { name: 'release-notes', aliases: ['changelog'], desc: 'View release notes for the current version', kind: 'tui' },
  { name: 'tutorial', aliases: ['tour', 'onboarding'], desc: 'Quick tips to get the most out of Grok Build', kind: 'tui' },
  { name: 'config-agents', aliases: ['agents'], desc: 'Manage agent definitions', kind: 'tui' },
  { name: 'personas', aliases: [], desc: 'Manage personas (create, edit, delete)', kind: 'tui' },
]

const SC = { sessionId: null, cwd: null, busy: false, cur: null }
function scAppendUser(text) {
  const row = el('div', 'sc-user')
  row.append(el('div', 'bubble', text))
  $('scBody').append(row)
  $('scBody').scrollTop = $('scBody').scrollHeight
}
function scAppendAssistant() {
  const md = el('div', 'md sc-assistant')
  md.textContent = '…'
  $('scBody').append(md)
  SC.cur = { mdNode: md, text: '' }
  return SC.cur
}
function scReset({ keepOpen = false, deleteSession = true } = {}) {
  if (SC.sessionId) {
    S.btwWatch.delete(SC.sessionId)
    if (SC.busy) requestCancel(SC.sessionId)
    if (deleteSession) {
      const { sessionId, cwd } = SC
      api('sessions:delete', { id: sessionId, cwd }).catch(() => {})
        .then(() => refreshSessionsSoon())
    }
  }
  SC.sessionId = null; SC.cwd = null; SC.busy = false; SC.cur = null
  $('scBody').innerHTML = ''
  if (!keepOpen) $('sideChat').hidden = true
}
function openSideChat(question) {
  $('sideChat').hidden = false
  if (question) scSubmit(question)
  else $('scInput').focus()
}
async function scSubmit(q) {
  q = (q || '').trim()
  if (!q || SC.busy) return
  const cwd = SC.cwd || S.active?.cwd || S.settings?.workspace?.lastCwd
  if (!cwd) { toast(t('Pick a working directory first')); return }
  SC.busy = true
  $('sideChat').classList.add('busy')
  scAppendUser(q)
  const card = scAppendAssistant()
  try {
    if (!SC.sessionId) {
      const r = await api('session:new', { cwd, presetId: S.settings?.presets?.default || null })
      SC.sessionId = r.sessionId
      SC.cwd = cwd
      S.btwWatch.set(SC.sessionId, (u) => {
        const c = SC.cur
        if (!c) return
        if (u.sessionUpdate === 'agent_message_chunk') {
          c.text += u.content?.text ?? ''
          c.displayText = stripSystemReminders(c.text)
          if (!c.displayText.trim()) return
          renderMd(c.mdNode, c.displayText)
          $('scBody').scrollTop = $('scBody').scrollHeight
        } else if (u.sessionUpdate === 'tool_call' && !c.text) {
          c.mdNode.textContent = t('(running tools…)')
        }
      })
    }
    const sideId = SC.sessionId
    const startedAt = Date.now()
    let stallTimer = null
    const stallGuard = new Promise((resolve) => {
      stallTimer = setInterval(() => {
        if ((S.lastEventBySession.get(sideId) || 0) >= startedAt) {
          clearInterval(stallTimer)
          return
        }
        if (Date.now() - startedAt > 150e3) resolve({ __stalled: true })
      }, 5000)
    })
    let done
    try {
      done = await Promise.race([api('session:prompt', { sessionId: sideId, text: q }), stallGuard])
    } finally {
      clearInterval(stallTimer)
    }
    if (done?.__stalled) requestCancel(sideId)
    if (!itemVisibleText(card).trim()) card.mdNode.textContent = t('(no answer)')
  } catch (err) {
    if ((isAccountSwitchedErr(err) || isSessionNotLoadedErr(err)) && SC.sessionId && SC.cwd) {
      try {
        await api('session:load', {
          sessionId: SC.sessionId, cwd: SC.cwd,
          presetId: S.settings?.presets?.default || null,
        })
        await api('session:prompt', { sessionId: SC.sessionId, text: q })
        if (!itemVisibleText(card).trim()) card.mdNode.textContent = t('(no answer)')
      } catch (err2) {
        card.mdNode.textContent = `${t('Error')}: ${err2.message}`
      }
    } else {
      card.mdNode.textContent = `${t('Error')}: ${err.message}`
    }
  } finally {
    SC.busy = false
    $('sideChat').classList.remove('busy')
  }
}
function scTakeInput() {
  if (SC.busy) { toast(t('A turn is still running — wait for it to finish')); return null }
  const v = $('scInput').value
  $('scInput').value = ''
  return v
}
$('scSend').addEventListener('click', () => { const v = scTakeInput(); if (v != null) scSubmit(v) })
$('scInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    const v = scTakeInput()
    if (v != null) scSubmit(v)
  }
})
$('scClose').addEventListener('click', () => scReset())
$('scClear').addEventListener('click', () => { scReset({ keepOpen: true }); $('scInput').focus() })
$('scPromote').addEventListener('click', () => {
  if (!SC.sessionId) { toast(t('Nothing to promote yet')); return }
  const { sessionId, cwd } = SC
  scReset({ deleteSession: false })
  refreshSessionsSoon()
  openSession({ id: sessionId, cwd, title: t('Side chat') })
})

function findFlash(node) {
  node.scrollIntoView({ block: 'center' })
  node.classList.add('find-hit')
  setTimeout(() => node.classList.remove('find-hit'), 1300)
}
const FIND = { bar: null, input: null, count: null, hits: [], idx: -1 }
function findRun(q) {
  FIND.hits = []; FIND.idx = -1
  q = q.trim().toLowerCase()
  if (!q) { FIND.count.textContent = ''; return }
  for (const it of S.active?.items || []) {
    const hay = `${itemVisibleText(it)}\n${it.title || ''}`.toLowerCase()
    if (hay.includes(q) && it.el?.isConnected) FIND.hits.push(it.el)
  }
  FIND.count.textContent = `0/${FIND.hits.length}`
  if (FIND.hits.length) findStep(1)
}
function findStep(dir) {
  if (!FIND.hits.length) return
  FIND.idx = (FIND.idx + dir + FIND.hits.length) % FIND.hits.length
  FIND.count.textContent = `${FIND.idx + 1}/${FIND.hits.length}`
  findFlash(FIND.hits[FIND.idx])
}
function openFindBar() {
  if (!S.active) { toast(t('No active session')); return }
  if (FIND.bar) { FIND.input.focus(); FIND.input.select(); return }
  const bar = el('div', 'find-bar')
  const input = el('input')
  input.placeholder = t('Find in conversation…')
  const count = el('span', 'cnt', '')
  const prev = el('button', 'icon-btn', '↑')
  const next = el('button', 'icon-btn', '↓')
  const close = el('button', 'icon-btn', '✕')
  bar.append(input, count, prev, next, close)
  document.querySelector('.main').append(bar)
  FIND.bar = bar; FIND.input = input; FIND.count = count
  const closeFn = () => { bar.remove(); FIND.bar = null; FIND.hits = []; FIND.idx = -1 }
  close.addEventListener('click', closeFn)
  prev.addEventListener('click', () => findStep(-1))
  next.addEventListener('click', () => findStep(1))
  input.addEventListener('input', () => findRun(input.value))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFn()
    else if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1) }
  })
  input.focus()
}
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && S.active && !$('chatView').hidden) {
    e.preventDefault()
    openFindBar()
  }
})

function listUserPrompts() {
  const seen = new Set(); const out = []
  const items = S.active?.items || []
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'user' && it.text && !seen.has(it.text)) { seen.add(it.text); out.push(it) }
  }
  return out
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)

function openPromptEditor() {
  const host = $('modalHost')
  host.innerHTML = ''
  const mask = el('div', 'modal-mask')
  const win = el('div', 'editor-win')
  win.setAttribute('role', 'dialog')
  win.setAttribute('aria-modal', 'true')
  const ta = el('textarea', 'e-ta')
  ta.value = inputEl.value
  const row = el('div', 'e-row')
  const cancel = el('button', 'e-btn', t('Cancel'))
  const use = el('button', 'e-btn primary', t('Use prompt'))
  row.append(cancel, use)
  win.append(el('div', 'e-title', t('Edit prompt')), ta, row)
  mask.append(win)
  host.append(mask)
  const close = () => { host.innerHTML = '' }
  cancel.addEventListener('click', close)
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close() })
  use.addEventListener('click', () => { inputEl.value = ta.value; autoGrow(); close(); inputEl.focus() })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close()
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) use.click()
  })
  ta.focus()
}

function applyUiPrefs() {
  document.body.classList.toggle('compact', !!S.settings?.ui?.compactMode)
  tInner.classList.toggle('show-ts', !!S.settings?.ui?.timestamps)
}
function toggleUiPref(key, onMsg, offMsg) {
  const v = !S.settings?.ui?.[key]
  S.settings.ui[key] = v
  api('settings:set', { ui: { [key]: v } }).catch(() => {})
  applyUiPrefs()
  toast(v ? onMsg : offMsg)
}

const BUILTIN_ACTIONS = {
  'quit': () => api('app:quit', {}).catch(() => window.close()),
  'help': () => { inputEl.value = '/'; inputEl.focus(); autoGrow(); maybeShowSlashMenu() },
  'docs': async () => {
    const url = 'https://docs.x.ai/build/overview'
    try { await navigator.clipboard.writeText(url); toast(`${t('Docs URL copied')}: ${url}`) } catch { toast(url) }
  },
  'home': () => showHome(),
  'resume': () => { showHome(); toast(t('Pick a session from the sidebar')) },
  'delete': async () => {
    const cur = S.active
    if (!cur) { toast(t('No active session')); return }
    try {
      if (sendingSessions.has(cur.sessionId)) requestCancel(cur.sessionId)
      await api('sessions:delete', { id: cur.sessionId, cwd: cur.cwd })
      S.sessions = S.sessions.filter((x) => x.id !== cur.sessionId)
      S.active = null
      showHome()
      renderSessionList()
      toast(t('Deleted permanently'))
    } catch (err) { toast(`${t('Delete failed')}: ${err.message}`) }
  },
  'new': () => { startNewSession() },
  'btw': (args) => { openSideChat(args) },
  'find': () => openFindBar(),
  'edit-prompt': () => openPromptEditor(),
  'context': () => $('usageBtn').click(),
  'tasks': () => wfOpen(),
  'workflows': () => wfOpen(),
  'history': () => {
    const prompts = listUserPrompts()
    if (!prompts.length) { toast(t('No prompts in this session yet')); return }
    showPopover(inputEl, prompts.slice(0, 30).map((it) => ({
      label: clip(it.text, 70),
      onPick: () => { inputEl.value = it.text; autoGrow(); inputEl.focus() },
    })), { above: true, title: t('Prompt history') })
  },
  'jump': () => {
    const prompts = listUserPrompts()
    if (!prompts.length) { toast(t('No prompts in this session yet')); return }
    showPopover(inputEl, prompts.slice(0, 30).map((it) => ({
      label: clip(it.text, 70),
      onPick: () => { if (it.el?.isConnected) findFlash(it.el) },
    })), { above: true, title: t('Jump to a turn') })
  },
  'view-plan': () => {
    if (S.active?.plan?.length) {
      S.active.planClosed = false
      ppSync()
    } else toast(t('No plan in this session yet'))
  },
  'multiline': () => toggleUiPref('multiline',
    t('Multiline on — Enter inserts a newline, Shift+Enter sends'),
    t('Multiline off — Enter sends')),
  'compact-mode': () => toggleUiPref('compactMode', t('Compact UI on'), t('Compact UI off')),
  'display-off': async () => {
    try {
      await api('display:sleep')
      toast(t('Display off — Grok keeps working'))
    } catch (e) { toast(e.message) }
  },
  'timestamps': () => toggleUiPref('timestamps', t('Timestamps on'), t('Timestamps off')),
  'voice': () => toast(t('Use macOS dictation: focus the input, then press 🎤 (or fn twice)')),
  'clear': async () => {
    const prev = S.active
    if (prev?.sessionId && sendingSessions.has(prev.sessionId)) {
      requestCancel(prev.sessionId)
    }
    const fresh = await startNewSession(prev?.cwd)
    if (!fresh || !prev?.sessionId) return
    try {
      await api('sessions:delete', { id: prev.sessionId, cwd: prev.cwd })
      S.sessions = (S.sessions || []).filter((x) => x.id !== prev.sessionId)
      renderSessionList()
    } catch (err) { toast(`${t('Delete failed')}: ${err.message}`) }
  },
  'copy': async () => {
    const items = S.active?.items || []
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'assistant' && !it.isPlan) {
        const vis = itemVisibleText(it).trim()
        if (!vis) continue
        try { await navigator.clipboard.writeText(vis); toast(t('Copied')) } catch { toast(t('Copy failed')) }
        return
      }
    }
    toast(t('Nothing to copy yet'))
  },
  'export': async () => {
    const items = S.active?.items || []
    const parts = []
    for (const it of items) {
      if (it.kind === 'user' && it.text) parts.push(`## You\n\n${it.text}`)
      else if (it.kind === 'assistant') {
        const vis = itemVisibleText(it).trim()
        if (vis) parts.push(`## ${it.isPlan ? 'Plan' : 'Grok'}\n\n${vis}`)
      }
      else if (it.kind === 'tool' && it.title) parts.push(`> [${it.toolKind || 'tool'}] ${it.title}`)
    }
    if (S.active?.plan?.length) {
      parts.push(`## Plan\n\n${S.active.plan.map((e) => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`).join('\n')}`)
    }
    if (!parts.length) { toast(t('Nothing to copy yet')); return }
    try { await navigator.clipboard.writeText(parts.join('\n\n')); toast(t('Conversation copied as Markdown')) } catch { toast(t('Copy failed')) }
  },
  'transcript': () => BUILTIN_ACTIONS['export'](),
  'model': () => $('modelBtn').click(),
  'effort': () => $('modelBtn').click(),
  'always-approve': () => setPermModeToggle('always-approve'),
  'auto': () => setPermModeToggle('auto-safe'),
  'session-info': () => {
    if (!S.active) { toast(t('No active session')); return }
    infoLine(`${t('Session')}: ${S.active.sessionId} · ${S.active.cwd} · ${S.currentModelId || ''}`)
    scrollDown(true)
  },
  'cd': async () => {
    const cwd = await api('workspace:pick')
    if (!cwd) return
    rememberCwd(cwd)
    toast(t('Working directory updated for new sessions'))
  },
  'theme': () => {
    const cur = S.settings.ui.theme || 'system'
    showPopover(inputEl, [['system', t('Follow system')], ['light', t('Light')], ['dark', t('Dark')]].map(([v, label]) => ({
      label, selected: cur === v,
      onPick: () => {
        S.settings.ui.theme = v
        applyTheme(v)
        api('settings:set', { ui: { theme: v } }).catch(() => {})
      },
    })), { above: true })
  },
  'settings': () => openSettings(),
  'privacy': () => openSettings('data'),
  'usage': () => openSettings('usage'),
  'queue': () => {
    const n = (S.active && S.queue.get(S.active.sessionId)?.entries.length) || 0
    toast(n ? t('{0} message(s) queued — see the strip above the input', n) : t('The queue is empty'))
  },
  'login': () => {
    api('account:login-start')
      .then(() => toast(t('Browser opened — finish sign-in there')))
      .catch((e) => toast(e.message))
  },
  'logout': async () => {
    try {
      await api('account:logout')
      resetAfterAccountChange()
      toast(t('Signed out; engine stopped'))
      showLoginView()
    } catch (e) { toast(`${t('Sign out failed')}: ${e.message}`) }
  },
}
async function setPermModeToggle(mode) {
  const next = (S.settings.engine.permissionMode === mode) ? 'ask' : mode
  try {
    await api('permission:set-mode', { mode: next })
    S.settings.engine.permissionMode = next
    updateMeta()
    toast(t(PERM_LABELS[next]))
  } catch (e) { toast(e.message) }
}

function findBuiltin(name) {
  const n = name.toLowerCase()
  return BUILTIN_COMMANDS.find((b) => b.name === n || (b.aliases || []).includes(n)) || null
}

// 一个 /token：字母开头，不含第二个斜杠 —— 用来把命令和「/Users/... 这是什么」区分开
const CMD_TOKEN = /^\/[A-Za-z][A-Za-z0-9_:.-]*$/

function acpHas(name) {
  const n = name.toLowerCase()
  return (S.availableCommands || []).some((c) => c.name.toLowerCase() === n)
}

/** 引擎把 skill 挂成限定名（bundled:imagine、local:commit）：裸名找不到时回退到唯一的 `*:name`。 */
function acpQualified(name) {
  const suffix = ':' + name.toLowerCase()
  const hits = (S.availableCommands || []).filter((c) => c.name.toLowerCase().endsWith(suffix))
  return hits.length === 1 ? hits[0].name : null
}

/**
 * 分流一条 /命令。
 * { handled: true } = 本地已经处理完，别再发给引擎；
 * 否则 text 是真正要发出去的文本（别名、裸 skill 名会被改写成引擎认识的写法）。
 */
function handleSlash(text) {
  const first = text.split(/\s+/)[0]
  const name = first.slice(1).toLowerCase()
  if (!name) return { handled: false, text }
  const rest = text.slice(first.length).trim()
  const pass = (n) => ({ handled: false, text: rest ? `/${n} ${rest}` : `/${n}` })
  const b = findBuiltin(name)

  // 引擎认这个名字 → 让给引擎（顺带把别名改写成正名，/status → /session-info）。
  // local 的是例外：这些名字 ACP 侧只吞不吐，本地实现必须压过它。
  if (b && !b.local && acpHas(b.name)) return pass(b.name)
  if (!b && acpHas(name)) return { handled: false, text }

  if (b) {
    if (b.kind === 'pass') return pass(b.name)
    // 引擎有限定名版本时优先走引擎，别把人打发去开 TUI
    const q = b.kind === 'tui' ? acpQualified(b.name) : null
    if (q) return pass(q)
    if (b.kind === 'tui') {
      toast(`/${b.name} ${t('is TUI-only — click ❯_ (top right) to open the grok TUI with this session')}`)
      return { handled: true }
    }
    BUILTIN_ACTIONS[b.name]?.(rest)
    return { handled: true }
  }

  // 谁都不认。只拦「光秃秃一个 /token」——后面跟着散文的是路径或正文（/tmp 快满了、
  // /plan.md 里写了什么），带点的同理；这些必须原样发出去。名单没补全前（冷启动，
  // skill/workflow 还没广播）一律不拦，否则新会话第一条 /skill 会被吃掉。
  // restore 让 send() 把输入框恢复原状：万一还是误判，用户的文字也不会没了。
  const q = acpQualified(name)
  if (q) return pass(q)
  if (S.cmdsFresh && !rest && !name.includes('.') && CMD_TOKEN.test(first)) {
    toast(`${t('Unknown command')} /${name} — ${t('type / to see what this session has')}`)
    return { handled: true, restore: true }
  }
  return { handled: false, text }
}

function allSlashCommands() {
  const acp = S.availableCommands || []
  const seen = new Set(acp.map((c) => c.name.toLowerCase()))
  // local 的本地实现压过引擎条目：菜单里点它要跑本地动作，而不是把 /context 填进输入框
  const merged = acp.map((c) => {
    const b = findBuiltin(c.name)
    return b && b.local ? { ...c, builtin: b, runNow: true } : c
  })
  const extras = BUILTIN_COMMANDS
    .filter((b) => !seen.has(b.name))
    .map((b) => ({ name: b.name, description: t(b.desc), builtin: b, runNow: b.kind !== 'pass' }))
  return merged.concat(extras)
}

function maybeShowSlashMenu() {
  const v = inputEl.value
  if (v.startsWith('/') && !v.includes(' ')) {
    const q = v.slice(1).toLowerCase()
    const cmds = allSlashCommands()
    const names = (c) => [c.name.toLowerCase(), ...((c.builtin?.aliases) || [])]
    const prefix = cmds.filter((c) => names(c).some((n) => n.startsWith(q)))
    const infix = q
      ? cmds.filter((c) => !names(c).some((n) => n.startsWith(q)) && names(c).some((n) => n.includes(q)))
      : []
    const matches = prefix.concat(infix)
    if (matches.length) {
      showPopover(inputEl, matches.map((c) => ({
        label: '/' + c.name + (c.builtin?.aliases?.length ? `  (${c.builtin.aliases.map((a) => '/' + a).join(' ')})` : ''),
        desc: c.description || '',
        title: c.description || '', // skill 描述整段很长，CSS 截两行，全文进 tooltip
        onPick: () => {
          if (c.runNow && c.builtin) {
            const r = handleSlash('/' + c.builtin.name)
            // handled=false 表示「这条得发出去」（/imagine → /bundled:imagine）：填正名，别当没发生
            inputEl.value = r.handled ? '' : r.text + ' '
            if (!r.handled) inputEl.focus()
            autoGrow()
            return
          }
          inputEl.value = '/' + c.name + ' '
          inputEl.focus()
          autoGrow()
        },
      })), { above: true })
      return
    }
  }
  if (popoverFor === inputEl) closePopover()
}

const popoverHost = $('popoverHost')
let popoverFor = null
function closePopover() { popoverHost.innerHTML = ''; popoverFor = null }
document.addEventListener('mousedown', (e) => {
  if (popoverHost.firstChild && !popoverHost.contains(e.target)) closePopover()
})
function showPopover(anchor, items, { above = false, title = null, custom = null, popClass = null } = {}) {
  closePopover()
  popoverFor = anchor
  const pop = el('div', popClass ? `popover ${popClass}` : 'popover')
  if (title) pop.append(el('div', 'pop-title', title))
  if (custom) pop.append(custom)
  for (const it of items) {
    if (it.sep) { pop.append(el('div', 'pop-sep')); continue }
    if (it.heading) { pop.append(el('div', 'pop-title', it.heading)); continue }
    if (it.row) { pop.append(it.row); continue }
    const btn = el('button', 'pop-item' + (it.selected ? ' sel' : ''))
    if (it.title || it.label) btn.title = it.title ? `${it.label}\n${it.title}` : it.label
    const col = el('span', 'col')
    col.append(el('span', 'v', it.label))
    if (it.desc) col.append(el('span', 'd', it.desc))
    btn.append(col)
    if (it.selected) btn.append(el('span', null, '✓'))
    btn.addEventListener('click', () => { closePopover(); it.onPick?.() })
    pop.append(btn)
  }
  popoverHost.append(pop)
  const r = anchor.getBoundingClientRect()
  const pr = pop.getBoundingClientRect()
  const vh = window.innerHeight
  let x = Math.min(r.left, window.innerWidth - pr.width - 12)
  let y = above ? r.top - pr.height - 8 : r.bottom + 8
  if (y + pr.height > vh - 8) y = r.top - pr.height - 8
  if (y < 44) {
    // 上下都塞不下（落地页输入框在正中间时就是这样）：挑空间大的一侧，并把弹层压到那一侧的高度。
    // 不压的话 max-height:62vh 会让菜单尾巴掉到窗口外面 —— 既够不着也滚不到。
    const roomAbove = r.top - 8 - 44
    const roomBelow = vh - 8 - (r.bottom + 8)
    const room = Math.max(120, roomAbove, roomBelow)
    pop.style.maxHeight = `${room}px`
    y = roomAbove >= roomBelow ? Math.max(44, r.top - Math.min(pr.height, room) - 8) : r.bottom + 8
  }
  pop.style.left = `${Math.max(8, x)}px`
  pop.style.top = `${y}px`
}

$('modelBtn').addEventListener('click', () => {
  if (!S.models.length) { toast(t('Engine is not ready yet')); return }
  const card = el('div', null)
  card.append(el('div', 'claude-ui-groupLabel', 'Model'))
  for (const m of S.models) {
    const row = el('button', 'claude-ui-modelRow')
    if (m.modelId === S.currentModelId) row.dataset.selected = 'true'
    row.append(el('span', 'claude-ui-modelName', m.name || m.modelId))
    if (m.modelId === S.currentModelId) row.append(el('span', 'claude-ui-tick', '✓'))
    row.addEventListener('click', () => { closePopover(); switchModel(m.modelId) })
    card.append(row)
  }
  const efforts = availableEfforts()
  if (efforts.length) card.append(buildEffortCard(efforts))
  showPopover($('modelBtn'), [], { custom: card, above: true, popClass: 'claude-ui-popover' })
})

async function switchModel(modelId) {
  if (modelId === S.currentModelId) return
  S.currentModelId = modelId
  S.settings.engine.model = modelId
  api('settings:set', { engine: { model: modelId } }).catch(() => {})
  updateMeta()
  if (S.active) {
    const sess = S.active
    try {
      const r = await api('session:set-model', {
        sessionId: sess.sessionId, modelId, cwd: sess.cwd,
        presetId: S.settings?.presets?.default || null,
      })
      // 重启路线在 renderer 无防护时已把历史重放了一遍（转录翻倍 + 幽灵回合）：按纪律重来
      if (r.reloaded && S.active === sess) await restoreActiveSession(sess)
      if (r.modelOk === false) {
        if (r.actualModel) { S.currentModelId = r.actualModel; updateMeta() }
        toast(`${t('Switch failed')}: ${t('the engine kept')} ${modelDisplay(r.actualModel || '?')}`)
        return
      }
      toast(r.via === 'live' ? `${t('Switched to')} ${modelDisplay(modelId)}` : `${t('Switched to')} ${modelDisplay(modelId)} ${t('(engine restarted, session restored)')}`)
    } catch (err) {
      toast(`${t('Switch failed')}: ${err.message}`)
      if (S.engineRunning && S.active === sess) await restoreActiveSession(sess)
    }
  } else {
    toast(`${t('New sessions will use')} ${modelDisplay(modelId)}`)
  }
}

const EFFORT_RANGE_MAX = 1000
function buildEffortCard(efforts) {
  const n = efforts.length
  const topIndex = n - 1
  const posOf = (i) => (topIndex <= 0 ? 100 : (i / topIndex) * 100)
  const idxOf = (pos) => (topIndex <= 0 ? 0 : Math.min(topIndex, Math.max(0, Math.round((pos / 100) * topIndex))))
  const labelOf = (i) => t(EFFORT_LABELS[efforts[i]?.id] || efforts[i]?.id)

  let stopIndex = Math.max(0, efforts.findIndex((e) => e.id === effectiveEffort()))
  let dragPos = null

  const wrap = el('div', 'claude-ui-effort')
  const head = el('div', 'claude-ui-effortHead')
  const headLeft = el('div', 'claude-ui-effortHeadLeft')
  const value = el('span', 'claude-ui-effortValue')
  headLeft.append(el('h2', 'claude-ui-effortTitle', 'Effort'), value)
  const info = el('button', 'claude-ui-effortInfo', '?')
  info.type = 'button'
  info.tabIndex = -1
  info.title = t('Right is slower but smarter; the top stop, Extra High, spends the model’s full reasoning budget (Grok 4.6 only).')
  head.append(headLeft, info)

  const ends = el('div', 'claude-ui-effortEnds')
  ends.append(el('span', null, 'Faster'), el('span', null, 'Smarter'))

  const slider = el('div', 'claude-ui-slider')
  const track = el('div', 'claude-ui-track')
  const fill = el('span', 'claude-ui-fill')
  const energy = el('span', 'claude-ui-energy')
  energy.setAttribute('aria-hidden', 'true')
  fill.append(energy)
  track.append(fill)
  const stops = el('span', 'claude-ui-stops')
  stops.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < n; i++) {
    const dot = el('span', 'claude-ui-stop')
    dot.style.setProperty('--dot-stagger', `${(topIndex - i) * 35}ms`)
    stops.append(dot)
  }
  const handleTrack = el('span', 'claude-ui-handleTrack')
  handleTrack.setAttribute('aria-hidden', 'true')
  handleTrack.append(el('span', 'claude-ui-handle'))
  const range = document.createElement('input')
  range.type = 'range'
  range.className = 'claude-ui-range'
  range.min = '0'
  range.max = String(EFFORT_RANGE_MAX)
  range.step = '1'
  range.setAttribute('aria-label', 'Effort')
  slider.append(track, stops, handleTrack, range)

  const update = () => {
    const livePos = dragPos ?? posOf(stopIndex)
    const liveIndex = idxOf(livePos)
    const liveAtTop = topIndex > 0 && liveIndex === topIndex
    slider.style.setProperty('--slider-pos', `${livePos}%`)
    if (liveAtTop) slider.dataset.topStop = 'true'
    else delete slider.dataset.topStop
    if (dragPos !== null) slider.dataset.dragging = 'true'
    else delete slider.dataset.dragging
    value.textContent = labelOf(liveIndex)
    if (liveAtTop) value.dataset.top = 'true'
    else delete value.dataset.top
    range.value = String(Math.round((livePos / 100) * EFFORT_RANGE_MAX))
    range.setAttribute('aria-valuetext', labelOf(liveIndex))
  }

  let finishing = false
  const posFromRange = () => (Number(range.value) / EFFORT_RANGE_MAX) * 100
  const onDrag = () => {
    finishing = false
    dragPos = posFromRange()
    update()
  }
  const finish = () => {
    if (finishing) return
    finishing = true
    const idx = idxOf(posFromRange())
    dragPos = null
    if (idx !== stopIndex) {
      stopIndex = idx
      applyEffort(efforts[idx].id)
    }
    update()
  }
  range.addEventListener('pointerdown', onDrag)
  range.addEventListener('input', onDrag)
  range.addEventListener('change', onDrag)
  range.addEventListener('pointerup', finish)
  range.addEventListener('pointercancel', finish)
  range.addEventListener('keyup', (ev) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key)) return
    finish()
  })

  update()
  wrap.append(head, ends, slider)
  return wrap
}

async function applyEffort(effortId) {
  S.currentEffort = effortId
  S.settings.engine.effort = effortId
  api('settings:set', { engine: { effort: effortId } }).catch(() => {})
  updateMeta()
  if (S.active) {
    const sess = S.active
    try {
      const r = await api('session:set-effort', {
        sessionId: sess.sessionId, effortId, cwd: sess.cwd,
        presetId: S.settings?.presets?.default || null,
      })
      // 同 switchModel：重启路线的重放要按全套纪律重来一遍
      if (r.reloaded && S.active === sess) await restoreActiveSession(sess)
      if (r.modelOk === false) {
        if (r.actualModel) { S.currentModelId = r.actualModel; updateMeta() }
        toast(`${t('Switch failed')}: ${t('the engine kept')} ${modelDisplay(r.actualModel || '?')}`)
        return
      }
      toast(r.via === 'live'
        ? `${t('Effort set to')} ${t(EFFORT_LABELS[effortId] || effortId)}`
        : `${t('Effort set to')} ${t(EFFORT_LABELS[effortId] || effortId)} ${t('(engine restarted, session restored)')}`)
    } catch (err) {
      toast(`${t('Effort change failed')}: ${err.message}`)
      if (S.engineRunning && S.active === sess) await restoreActiveSession(sess)
    }
  } else {
    toast(`${t('New sessions will use')} ${t(EFFORT_LABELS[effortId] || effortId)}`)
  }
}

$('permBtn').addEventListener('click', () => {
  const cur = S.settings.engine.permissionMode || 'ask'
  showPopover($('permBtn'), Object.entries(PERM_LABELS).map(([v, label]) => ({
    label: t(label),
    desc: v === 'ask' ? t('Confirm every tool call') : v === 'auto-safe' ? t('Read-only tools run freely; writes need approval') : t('Approve everything automatically (trusted)'),
    selected: cur === v,
    onPick: async () => {
      try {
        await api('permission:set-mode', { mode: v })
        S.settings.engine.permissionMode = v
        updateMeta()
      } catch (e) { toast(e.message) }
    },
  })), { above: true })
})

function presetLabel(p) {
  if (!p) return ''
  if (p.nameKey) return t(p.nameKey, ...(p.nameArgs || []))
  return p.name || p.id
}

$('presetChip').addEventListener('click', async () => {
  try { S.presets = await api('presets:list') } catch {}
  const items = [{
    label: t('Native prompt'),
    desc: t('Grok’s built-in system prompt, unmodified'),
    selected: !S.settings.presets.default,
    onPick: () => pickPreset(null),
  }]
  for (const p of S.presets) {
    items.push({
      label: presetLabel(p),
      desc: `${p.description} ${t('(fully replaces the built-in prompt)')}`,
      selected: S.settings.presets.default === p.id,
      onPick: () => pickPreset(p.id),
    })
  }
  showPopover($('presetChip'), items, { above: true })
})
function pickPreset(id) {
  S.settings.presets.default = id
  api('settings:set', { presets: { default: id } }).catch(() => {})
  updateMeta()
  toast(id ? t('Preset selected — takes effect on the next new session') : t('Back to grok’s native prompt'))
}

$('cwdChip').addEventListener('click', () => openCwdMenu())

$('engineBtn').addEventListener('click', () => {
  const pop = el('div', 'usage-pop')
  const title = el('div', 'u-title')
  const dot = el('span', null, '●')
  dot.style.color = S.engineRunning ? 'var(--c-success)' : 'var(--c-danger)'
  title.append(dot, el('span', null, S.engineRunning ? t('Engine running') : t('Engine stopped')))
  pop.append(title)

  const m = currentModel()
  if (m?._meta?.totalContextTokens) {
    const row = el('div', 'u-row')
    row.append(el('span', null, t('Context window')), el('span', 'n', fmtBig(m._meta.totalContextTokens)))
    pop.append(row)
  }
  if (S.lastUsage) {
    const u = S.lastUsage
    const rows = [
      [t('Last input'), fmtTokens(u.inputTokens)],
      [t('Last output'), fmtTokens(u.outputTokens)],
      [t('Cache hits'), fmtTokens(u.cachedReadTokens)],
      [t('Reasoning tokens'), fmtTokens(u.reasoningTokens)],
    ]
    for (const [k, v] of rows) {
      const row = el('div', 'u-row')
      row.append(el('span', null, k), el('span', 'n', v))
      pop.append(row)
    }
    if (m?._meta?.totalContextTokens && u.totalTokens) {
      const pct = Math.min(100, Math.round((u.totalTokens / m._meta.totalContextTokens) * 100))
      const barWrap = el('div', 'u-bar')
      const bar = el('div')
      bar.style.width = `${pct}%`
      barWrap.append(bar)
      const row = el('div', 'u-row')
      row.append(el('span', null, t('Context used this session')), el('span', 'n', `${pct}%`))
      pop.append(row, barWrap)
    }
  }
  if (!S.engineRunning) {
    const btn = el('button', 'perm-btn allow', t('Restart engine'))
    btn.addEventListener('click', async () => {
      closePopover()
      try {
        await api('engine:start', {})
        await restoreActiveSession()
      } catch (e) { toast(`${t('Restart failed')}: ${e.message}`) }
    })
    pop.append(btn)
  }
  showPopover($('engineBtn'), [], { custom: pop })
})

function ctxUsedTokens() {
  if (S.active?.ctxTokens > 0) return S.active.ctxTokens
  if (S.active && S.lastUsageSid === S.active.sessionId && S.lastUsage?.totalTokens > 0) return S.lastUsage.totalTokens
  return 0
}

function fmtCtx(n) {
  return fmtBig(n).replace(/\.0(?=[kMB])/, '')
}

function updateUsageRing() {
  const btn = $('usageBtn')
  const max = currentModel()?._meta?.totalContextTokens || 0
  const used = ctxUsedTokens()
  const p = max > 0 ? Math.min(1, used / max) : 0
  if (btn) {
    btn.style.setProperty('--p', String(p))
    btn.classList.toggle('warn', p >= 0.7 && p < 0.9)
    btn.classList.toggle('hot', p >= 0.9)
    btn.title = max
      ? `${t('Context window')}: ${fmtBig(used)} / ${fmtBig(max)} (${Math.round(p * 100)}%)`
      : t('Context & usage')
  }
  const head = $('headCtx')
  if (head) {
    head.hidden = !max
    if (max) {
      head.textContent = `${fmtCtx(used)}/${fmtCtx(max)}`
      head.title = `${t('Context window')}: ${fmtBig(used)} / ${fmtBig(max)} (${Math.round(p * 100)}%)`
    }
  }
}

function relAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60e3)
  if (m < 1) return null
  if (m < 60) return t('{0} min', m)
  const h = Math.floor(m / 60)
  return h < 48 ? t('{0} h', h) : t('{0} d', Math.floor(h / 24))
}

function planUsageMode() {
  return S.settings?.ui?.planUsage === 'merged' ? 'merged' : 'separate'
}
function setPlanUsageMode(mode) {
  const v = mode === 'merged' ? 'merged' : 'separate'
  if (!S.settings.ui) S.settings.ui = {}
  S.settings.ui.planUsage = v
  api('settings:set', { ui: { planUsage: v } }).catch(() => {})
}
function periodLimitName(type) {
  const s = String(type || '')
  if (s.includes('WEEKLY')) return t('Weekly limit')
  if (s.includes('MONTHLY')) return t('Monthly limit')
  return t('Current period')
}
function buildPlanUsageSeg(onChange) {
  const seg = el('span', 'seg ul-mode')
  const cur = planUsageMode()
  for (const [v, label] of [['separate', t('Each account')], ['merged', t('Combined')]]) {
    const b = el('button', cur === v ? 'cur' : '', label)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      if (v === cur) return
      setPlanUsageMode(v)
      onChange?.()
    })
    seg.append(b)
  }
  return seg
}

function planLimitRows(b) {
  const cfg = b?.config || {}
  const rows = []
  const accts = Array.isArray(b?._accounts) ? b._accounts : []
  const separate = planUsageMode() === 'separate' && accts.length > 1
  if (separate) {
    const inferred = accts.map((a) => a.periodType).find(Boolean) || cfg.currentPeriod?.type
    for (const a of accts) {
      const who = a.email || a.name || a.id
      const mark = a.active ? ` · ${t('active')}` : (a.exhausted ? ` · ${t('exhausted')}` : '')
      rows.push({
        name: periodLimitName(a.periodType || inferred),
        who: who + mark,
        reset: fmtReset(a.periodEnd),
        pct: a.percent,
      })
    }
  } else {
    let pct = cfg.creditUsagePercent
    if (pct == null && cfg.used?.val != null && cfg.monthlyLimit?.val) {
      pct = (cfg.used.val / cfg.monthlyLimit.val) * 100
    }
    if (pct == null && b?.config != null) pct = 0
    if (pct != null) {
      const period = cfg.currentPeriod || {}
      rows.push({
        name: periodLimitName(period.type),
        reset: fmtReset(period.end || cfg.billingPeriodEnd),
        pct,
      })
    }
  }
  const odCap = cfg.onDemandCap?.val || 0
  const odUsed = cfg.onDemandUsed?.val || 0
  if ((b.on_demand_enabled ?? b.onDemandEnabled) && odCap > 0) {
    const usd = (cent) => `$${(((cent && cent.val) || 0) / 100).toFixed(2)}`
    rows.push({ name: t('On-demand'), reset: `${usd(cfg.onDemandUsed)} / ${usd(cfg.onDemandCap)}`, pct: (odUsed / odCap) * 100 })
  }
  return rows
}

function buildUsagePopChildren(rerender) {
  const out = []
  const m = currentModel()
  const max = m?._meta?.totalContextTokens || 0
  const used = ctxUsedTokens()
  const pctI = max > 0 ? Math.round(Math.min(1, used / max) * 100) : null

  const head = el('div', 'cu-head')
  head.append(el('span', null, t('Context window')))
  head.append(el('span', 'v', max ? `${fmtBig(used)} / ${fmtBig(max)}${pctI != null ? ` (${pctI}%)` : ''}` : '—'))
  out.push(head)

  const bar = el('div', 'cu-bar')
  if (max > 0 && used > 0) {
    const u = (S.active && S.lastUsageSid === S.active.sessionId) ? S.lastUsage : null
    const segs = u ? [
      ['seg-cache', u.cachedReadTokens || 0, t('Cache hits')],
      ['seg-in', u.inputTokens || 0, t('Last input')],
      ['seg-out', u.outputTokens || 0, t('Last output')],
      ['seg-think', u.reasoningTokens || 0, t('Reasoning tokens')],
    ].filter(([, v]) => v > 0) : []
    const sum = segs.reduce((a, [, v]) => a + v, 0)
    if (sum > 0) {
      const k = Math.min(1, used / sum)
      for (const [cls, v, label] of segs) {
        const s = el('span', cls)
        s.style.width = `${Math.max(0.8, (v * k / max) * 100)}%`
        s.title = `${label}: ${fmtTokens(v)}`
        bar.append(s)
      }
      if (sum < used) {
        const rest = el('span', 'seg-plain')
        rest.style.width = `${((used - sum) / max) * 100}%`
        bar.append(rest)
      }
    } else {
      const s = el('span', 'seg-plain')
      s.style.width = `${Math.min(100, (used / max) * 100)}%`
      bar.append(s)
    }
  }
  out.push(bar)

  const ago = S.ctxAt ? relAgo(S.ctxAt) : null
  out.push(el('div', 'cu-sub', !S.ctxAt || used <= 0
    ? t('Send a message to measure context usage.')
    : (ago ? t('Last updated {0} ago. Send a message to refresh.', ago) : t('Last updated just now.'))))

  out.push(el('div', 'cu-sep'))

  const lh = el('div', 'cu-limits-head')
  lh.append(el('span', null, t('Plan usage limits')))
  const tier = UL.b?.subscription_tier || UL.b?.subscriptionTier
  if (tier) lh.append(el('span', 'plan', tier))
  else if (UL.b?._mergedCount > 1) lh.append(el('span', 'plan', t('{0} accounts', UL.b._mergedCount)))
  const go = el('button', 'go', '→')
  go.title = t('Open the full usage page')
  go.addEventListener('click', () => { closePopover(); openSettings('usage') })
  lh.append(go)
  out.push(lh)

  const accts = Array.isArray(UL.b?._accounts) ? UL.b._accounts : []
  if (accts.length > 1) out.push(buildPlanUsageSeg(() => rerender?.()))

  if (UL.b) {
    const rows = planLimitRows(UL.b)
    for (const r of rows) {
      const lim = el('div', 'cu-lim')
      const top = el('div', 'cu-lim-top')
      top.append(el('span', 'n', r.name))
      if (r.reset) top.append(el('span', 'r', r.reset))
      const pctTxt = r.pct == null ? '—' : `${Math.round(Math.max(0, Math.min(100, r.pct)))}%`
      top.append(el('span', 'p', pctTxt))
      const b2 = el('div', 'cu-bar')
      const f = el('span', 'seg-plain')
      f.style.width = r.pct == null ? '0%' : `${Math.max(0, Math.min(100, r.pct))}%`
      b2.append(f)
      lim.append(top, b2)
      if (r.who) lim.append(el('div', 'cu-lim-who', r.who))
      out.push(lim)
    }
    if (!rows.length) out.push(el('div', 'hint', t('The backend did not return a usage percentage.')))
  } else {
    out.push(el('div', 'hint', UL.lastErr
      ? `${t('Failed to fetch usage')}: ${UL.lastErr}`
      : t('Fetching subscription usage from the engine…')))
  }
  return out
}

function openUsagePop(anchor, { above = false } = {}) {
  const pop = el('div', 'cu-pop')
  const render = () => pop.replaceChildren(...buildUsagePopChildren(render))
  render()
  Promise.resolve(prefetchUsage(UL.b ? false : true, { deep: !UL.b })).then(() => {
    if (popoverFor === anchor && pop.isConnected) render()
  }).catch(() => {})
  showPopover(anchor, [], { custom: pop, above })
}
$('usageBtn').addEventListener('click', () => openUsagePop($('usageBtn'), { above: true }))
$('headCtx').addEventListener('click', () => openUsagePop($('headCtx')))

function updateMeta() {
  $('modelLabel').textContent = currentModel() ? modelDisplay(S.currentModelId) : t('Model')
  const effort = effectiveEffort()
  const et = $('effortLabel')
  et.textContent = t(EFFORT_LABELS[effort] || effort)
  et.classList.toggle('ultra', effort === 'xhigh')
  const mode = S.settings?.engine?.permissionMode || 'ask'
  $('permBtn').textContent = `${t(PERM_LABELS[mode])} ⌵`

  const chipFill = (chip, svgPath, label, vb = '0 0 16 16') => {
    chip.replaceChildren()
    const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    ic.setAttribute('viewBox', vb)
    ic.setAttribute('class', 'chip-ico')
    ic.innerHTML = svgPath
    const txt = el('span', null, label)
    const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    chev.setAttribute('viewBox', '0 0 14 14')
    chev.setAttribute('class', 'claude-ui-chevron')
    chev.innerHTML = '<path d="M3.5 5.25 7 8.75l3.5-3.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    chip.append(ic, txt, chev)
  }
  const FOLDER_PATH = '<path d="M1.8 4.2a1.2 1.2 0 0 1 1.2-1.2h3.2l1.6 1.8h5.4a1.2 1.2 0 0 1 1.2 1.2v6a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/>'
  const GROK_MARK_PATHS = '<path fill="currentColor" d="M210.484 312.759L343.465 210.383C349.984 205.364 359.302 207.322 362.408 215.117C378.758 256.231 371.454 305.64 338.925 339.563C306.397 373.487 261.137 380.927 219.768 363.983L174.577 385.803C239.394 432.008 318.104 420.581 367.289 369.251C406.303 328.564 418.386 273.104 407.088 223.091L407.19 223.198C390.807 149.726 411.218 120.359 453.03 60.3072C454.02 58.8833 455.01 57.4595 456 56L400.978 113.382V113.204L210.45 312.794"/><path fill="currentColor" d="M183.042 337.641C136.519 291.294 144.54 219.567 184.236 178.203C213.59 147.59 261.683 135.096 303.666 153.464L348.755 131.75C340.632 125.627 330.221 119.042 318.275 114.414C264.277 91.2407 199.63 102.774 155.735 148.516C113.513 192.549 100.236 260.254 123.036 318.027C140.069 361.206 112.148 391.748 84.0229 422.575C74.0561 433.503 64.0553 444.431 56 456L183.007 337.677"/>'

  const presetId = S.settings?.presets?.default
  const preset = S.presets.find((p) => p.id === presetId)
  chipFill($('presetChip'), GROK_MARK_PATHS, preset ? presetLabel(preset) : t('Native prompt'), '0 0 512 512')

  const cwd = S.active?.cwd || S.settings?.workspace?.lastCwd
  const cwdChip = $('cwdChip')
  chipFill(cwdChip, FOLDER_PATH, cwd ? folderName(cwd) : t('Choose a folder'))
  cwdChip.title = cwd || t('Choose a folder')

  updateUsageRing()
  if (S.active) setChatHeader()
}

let refreshTimer = null
function refreshSessionsSoon() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(refreshSessions, 800)
}
async function refreshSessions() {
  try { S.sessions = await api('sessions:list') } catch { return }
  renderSessionList()
}

function renderSessionList() {
  const host = $('sessionList')
  host.innerHTML = ''
  const q = S.searchQuery.trim().toLowerCase()
  const list = q
    ? S.sessions.filter((s) => displayTitle(s).toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q))
    : S.sessions
  const groups = new Map()
  for (const s of list) {
    if (!groups.has(s.cwd)) groups.set(s.cwd, [])
    groups.get(s.cwd).push(s)
  }
  for (const [cwd, sess] of groups) {
    const h = el('div', 'group-h')
    const ico = el('span', 'g-ico', '▤')
    const name = el('span', 'g-name', folderName(cwd))
    name.title = cwd
    const add = el('button', 'g-add', '＋')
    add.title = `${t('New session in')} ${cwd}`
    add.addEventListener('click', (e) => {
      e.stopPropagation()
      startNewSession(cwd)
    })
    h.append(ico, name, add)
    host.append(h)
    for (const s of sess) {
      const working = sendingSessions.has(s.id)
      const row = el('div', 'sess' + (S.active?.sessionId === s.id ? ' active' : '') + (working ? ' working' : ''))
      row.dataset.sid = s.id
      if (working) row.setAttribute('aria-busy', 'true')
      const spin = el('span', 'sess-spin')
      spin.setAttribute('aria-hidden', 'true')
      const tEl = el('span', 't', displayTitle(s))
      tEl.title = s.title || s.id
      const when = el('span', 'when', fmtWhen(s.updatedAt))
      const del = el('button', 'del', '🗑')
      del.title = t('Delete permanently (cannot be undone)')
      del.addEventListener('click', async (e) => {
        e.stopPropagation()
        try {
          if (sendingSessions.has(s.id)) requestCancel(s.id)
          await api('sessions:delete', { id: s.id, cwd: s.cwd })
          S.sessions = S.sessions.filter((x) => x.id !== s.id)
          if (S.active?.sessionId === s.id) {
            S.active = null
            showHome()
          }
          renderSessionList()
          toast(t('Deleted permanently'))
        } catch (err) {
          toast(`${t('Delete failed')}: ${err.message}`)
        }
      })
      row.append(spin, tEl, when, del)
      row.addEventListener('click', () => openSession(s))
      host.append(row)
    }
  }
}

function syncSessionWorkingMarks() {
  const host = $('sessionList')
  if (!host) return
  for (const row of host.querySelectorAll('.sess[data-sid]')) {
    const on = sendingSessions.has(row.dataset.sid)
    row.classList.toggle('working', on)
    if (on) row.setAttribute('aria-busy', 'true')
    else row.removeAttribute('aria-busy')
  }
}

$('btnSearch').addEventListener('click', () => {
  const row = $('searchRow')
  row.hidden = !row.hidden
  if (!row.hidden) $('searchInput').focus()
  else { S.searchQuery = ''; $('searchInput').value = ''; renderSessionList() }
})
$('searchInput').addEventListener('input', () => {
  S.searchQuery = $('searchInput').value
  renderSessionList()
})

const permArea = $('permArea')
on('evt:permission-request', (req) => {
  if (req.sessionId && S.btwWatch.has(req.sessionId)) {
    const rej = (req.options || []).find((o) => String(o.kind || '').startsWith('reject'))
    api('permission:respond', { key: req.key, optionId: rej?.optionId ?? null }).catch(() => {})
    return
  }
  if (req.sessionId && req.sessionId !== S.active?.sessionId) {
    // 后台会话在等权限：暂存，切回那个会话时补弹（多会话并行后这是常态，
    // 直接丢弃的话那个会话的工具会永久挂起）。S.active 为空（落地页/建会话中）
    // 时一律暂存，别把外人的审批卡渲染到当前视图里被误点
    const q = S.pendingPerms.get(req.sessionId) || []
    q.push(req)
    S.pendingPerms.set(req.sessionId, q)
    toast(`${t('Another session is asking for permission')}`)
    return
  }
  renderPermCard(req)
})
// 已弹出但还没答复的权限卡（key -> req）：切会话时收回暂存，切回来补弹
const livePerms = new Map()
function stashLivePerms() {
  for (const req of livePerms.values()) {
    if (!req.sessionId) continue
    const q = S.pendingPerms.get(req.sessionId) || []
    q.push(req)
    S.pendingPerms.set(req.sessionId, q)
  }
  livePerms.clear()
}
function drainPendingPerms(sessionId) {
  for (const req of S.pendingPerms.get(sessionId) || []) renderPermCard(req)
  S.pendingPerms.delete(sessionId)
}
function renderPermCard(req) {
  livePerms.set(req.key, req)
  const card = el('div', 'perm-card')
  card.dataset.sid = req.sessionId || ''
  card.setAttribute('role', 'dialog')
  const toolTitle = req.toolCall?.title || req.toolCall?._meta?.['x.ai/tool']?.label || t('Tool call')
  card.append(el('div', 'q', `${t('Grok wants to run')}: ${toolTitle}`))
  const rawIn = req.toolCall?.rawInput
  if (rawIn?.command) card.append(el('div', 'd', rawIn.command))
  else if (rawIn) card.append(el('div', 'd', JSON.stringify(rawIn).slice(0, 400)))
  const opts = el('div', 'opts')
  for (const o of req.options || []) {
    const isAllow = String(o.kind || '').startsWith('allow')
    const b = el('button', 'perm-btn ' + (isAllow ? 'allow' : 'deny'), o.name || o.optionId)
    b.addEventListener('click', () => {
      livePerms.delete(req.key)
      api('permission:respond', { key: req.key, optionId: o.optionId })
        .then((ok) => { if (!ok) toast(t('This request already expired (the engine restarted)')) })
        .catch((e) => toast(e.message))
      card.remove()
    })
    opts.append(b)
  }
  card.append(opts)
  permArea.append(card)
}

function setEngineState(running) {
  S.engineRunning = running
  $('engineDot').classList.toggle('dead', !running)
}

on('evt:engine-ready', (init) => {
  S.initInfo = init
  const ms = init?._meta?.modelState
  if (ms) {
    S.models = ms.availableModels || []
    S.currentModelId = S.settings?.engine?.model || ms.currentModelId
  }
  S.cmdsFresh = false // 引擎刚起来：名单退回 initialize 那 7 条，等 session/new 后的广播补全
  if (init?._meta?.availableCommands) S.availableCommands = init._meta.availableCommands
  setEngineState(true)
  $('bannerArea').innerHTML = ''
  updateMeta()
  prefetchAccount(true)
  prefetchUsage(true, { deep: true })
})

function showEngineDownBanner(message) {
  setEngineState(false)
  const area = $('bannerArea')
  area.innerHTML = ''
  const b = el('div', 'banner')
  b.append(el('span', 'grow', message || t('The grok engine process exited.')))
  const btn = el('button', null, t('Restart engine'))
  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      await api('engine:start', {})
      area.innerHTML = ''
      await restoreActiveSession()
    } catch (err) {
      toast(`${t('Restart failed')}: ${err.message}`)
      btn.disabled = false
    }
  })
  b.append(btn)
  area.append(b)
}

on('evt:engine-exit', (info) => {
  if ($('permArea').children.length || livePerms.size || S.pendingPerms.size) {
    $('permArea').innerHTML = ''
    livePerms.clear()
    S.pendingPerms.clear() // waiters died with the engine process
    toast(t('Pending permission requests were cancelled'))
  }
  // 队列随引擎进程死光：清本地镜像，队列认领的回合当场收尾——不能只 clear()
  // 代际集（那会让 maybeEndQueuedTurnUI 的成员测试永远失败，生成态卡死、发送键锁死）
  S.queue.clear()
  renderQueueRow()
  for (const timer of cancelWatchdogs.values()) clearTimeout(timer)
  cancelWatchdogs.clear()
  for (const [sid, epoch] of [...sendingSessions]) {
    if (!queueTurnEpochs.has(epoch)) continue // send() 认领的回合由它自己的 finally 收
    sendingSessions.delete(sid)
    queueTurnEpochs.delete(epoch)
    if (S.active?.sessionId === sid) {
      S.active.streaming = false
      finishAllThoughts()
    }
    if (TS.sessionId === sid) tsEnd()
  }
  refreshSendState()
  // Intentional stop still means the process is gone. Keep the crash banner
  // off (restart is in flight), but never leave the UI thinking grok is live.
  setEngineState(false)
  if (info?.intentional) return
  showEngineDownBanner()
})

on('evt:session-update', handleUpdate)

on('evt:engine-notification', ({ method, params }) => {
  if (method === '_x.ai/models/update') {
    S.models = params.availableModels || S.models
    if (!S.settings?.engine?.model) S.currentModelId = params.currentModelId
    updateMeta()
  } else if (method === '_x.ai/sessions/changed') {
    refreshSessionsSoon()
  } else if (/x\.ai\/queue\/changed$/.test(method)) {
    // server-authoritative 队列对账：按会话每次全量重建（no-op 操作引擎也会原样重广播；
    // 广播是全局的，单一镜像会让 A 的广播误判 B 的队列回合已空转）
    if (params?.sessionId) {
      S.queue.set(params.sessionId, {
        entries: params?.entries || [],
        runningPromptId: params?.runningPromptId || null,
      })
      renderQueueRow()
      maybeEndQueuedTurnUI(params.sessionId)
    }
  } else if (/x\.ai\/session\/interjection$/.test(method)) {
    // goal 回合的同回合注入回显（非 goal 走 cancel+新回合，引擎不发这个广播；
    // 引擎注明：广播即回显，之后不再发 user_message_chunk）
    if (params?.sessionId === S.active?.sessionId && params?.text) {
      if (params.hideFromScrollback || isHiddenPromptId(params.promptId)
          || isSystemReminderPayload(params.text)) return
      const item = newUserItem(null)
      item.text = params.text
      item.bodyNode.textContent = params.text
      scrollDown(false)
    }
  } else if (/x\.ai\/session\/update$/.test(method)) {
    const u = params?.update
    if (u?.sessionUpdate === 'turn_completed') {
      onTurnCompleted(params?.sessionId, u, params)
    }
  } else if (/x\.ai\/session\/prompt_complete$/.test(method)) {
    onTurnCompleted(params?.sessionId, {
      prompt_id: params?.promptId || params?.prompt_id,
      stop_reason: params?.stopReason || params?.stop_reason,
      usage: params?.usage,
    }, params)
  } else if (/x\.ai\/session_notification$/.test(method)) {
    // {sessionId, update:{sessionUpdate:'workflow_updated', run_id, phases, agents…}}
    const u = params?.update
    if (u?.sessionUpdate === 'workflow_updated') {
      if (params?.sessionId && !u.sessionId) u.sessionId = params.sessionId
      wfIngest(u)
    } else if (u?.sessionUpdate === 'turn_completed') {
      onTurnCompleted(params?.sessionId, u, params)
    }
  }
})

const WF = { runs: new Map(), open: false, dismissed: new Set(), timer: null, tok: new Map(), tokBusy: false }
function wfIngest(u) {
  if (!u.run_id) return
  const prev = WF.runs.get(u.run_id)
  // Engine currently ships elapsed_ms/tokens_used/duration_ms as 0 until an
  // agent completes. Keep first-seen timestamps so the panel can tick locally
  // and so a later workflow_updated does not reset the clock to 0s.
  u.receivedAt = prev?.receivedAt || Date.now()
  u.sessionId = u.sessionId || prev?.sessionId
  const prevByKey = new Map()
  for (const a of prev?.agents || []) {
    const key = a.agent_id || a.label
    if (key) prevByKey.set(key, a)
  }
  for (const a of u.agents || []) {
    const key = a.agent_id || a.label
    const p = key ? prevByKey.get(key) : null
    a.seenAt = p?.seenAt || Date.now()
  }
  WF.runs.set(u.run_id, u)
  const active = u.status === 'active'
  if (active && !WF.dismissed.has(u.run_id) && !WF.open) wfOpen()
  else wfPullTok()
  wfRender()
  wfArmTimer()
}
// ── 计划栏：模型 plan 渲染到右侧 grid 列（不进对话流），图标是内联 SVG 不用 emoji ──
const PP_ICONS = {
  pending: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  in_progress: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.1 A3.9 3.9 0 0 1 8 11.9 Z" fill="currentColor"/></svg>',
  completed: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.9 8.3 7 10.4 11.2 5.9" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}
function ppSync() {
  const show = !!S.active?.plan?.length && !S.active.planClosed && $('homeView').hidden
  $('planPanel').hidden = !show
  if (show) ppRender()
}
function ppRender() {
  const entries = S.active?.plan || []
  const body = $('ppBody')
  body.innerHTML = ''
  let done = 0
  for (const e of entries) {
    const st = e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'cur' : 'todo'
    if (st === 'done') done++
    const row = el('div', `pp-item ${st}`)
    const ico = el('span', 'pp-ico')
    ico.innerHTML = PP_ICONS[e.status] || PP_ICONS.pending
    row.append(ico, el('span', 'lbl', e.content || ''))
    body.append(row)
  }
  $('ppCount').textContent = `${done}/${entries.length}`
  $('ppBar').style.width = entries.length ? `${Math.round((done / entries.length) * 100)}%` : '0'
}
$('ppClose').addEventListener('click', () => {
  $('planPanel').hidden = true
  if (S.active) S.active.planClosed = true // 本会话不再自动弹；/view-plan 重新打开
})

function wfHasLive() {
  for (const r of WF.runs.values()) {
    if (r.status === 'active' || r.status === 'paused') return true
  }
  return false
}
function wfArmTimer() {
  clearInterval(WF.timer)
  WF.timer = null
  if (!WF.open || document.hidden || !wfHasLive()) return
  WF.timer = setInterval(() => {
    if (!WF.open || document.hidden || !wfHasLive()) {
      wfArmTimer()
      return
    }
    wfPullTok()
    wfTickLive()
  }, 1000)
}
function wfOpen() {
  WF.open = true
  $('taskPanel').hidden = false
  wfArmTimer()
  wfPullTok()
  wfRender()
}
function wfWantedIds() {
  const ids = []
  const seen = new Set()
  for (const r of WF.runs.values()) {
    for (const a of r.agents || []) {
      const id = a.agent_id
      if (!id || seen.has(id) || a.tokens_used > 0) continue
      seen.add(id)
      ids.push(id)
    }
  }
  return ids.slice(0, 32)
}
function wfPullTok() {
  const ids = wfWantedIds()
  if (!ids.length || WF.tokBusy) return
  WF.tokBusy = true
  const cwd = S.active?.cwd || S.settings?.workspace?.lastCwd || null
  api('workflow:live-tokens', { cwd, agentIds: ids }).then((m) => {
    if (!m || typeof m !== 'object') return
    for (const [id, v] of Object.entries(m)) {
      if (v && typeof v === 'object') WF.tok.set(id, v)
    }
    if (WF.open) wfTickLive()
  }).catch(() => {}).finally(() => { WF.tokBusy = false })
}
function wfClose() {
  WF.open = false
  $('taskPanel').hidden = true
  wfArmTimer()
  for (const [id, r] of WF.runs) if (r.status === 'active') WF.dismissed.add(id)
}
document.addEventListener('visibilitychange', () => {
  wfArmTimer()
  if (!document.hidden && WF.open && wfHasLive()) {
    wfPullTok()
    wfTickLive()
  }
})
$('tpClose').addEventListener('click', wfClose)
function wfFmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`
}
function wfAgentLive(a) {
  return a.state === 'running' || a.state === 'active'
}
function wfElapsed(r) {
  const engine = r.elapsed_ms || 0
  if (r.status !== 'active') return engine
  if (engine > 0) return engine
  return Date.now() - (r.receivedAt || Date.now())
}
function wfAgentDur(a) {
  if (a.duration_ms > 0) return a.duration_ms
  if (wfAgentLive(a) && a.seenAt) return Date.now() - a.seenAt
  return a.duration_ms || 0
}
function wfTokNum(a) {
  if (a.tokens_used > 0) return a.tokens_used
  const live = a.agent_id ? WF.tok.get(a.agent_id) : null
  if (live?.billed > 0) return live.billed
  if (live?.context > 0) return live.context
  return 0
}
function wfFmtTok(a) {
  const n = wfTokNum(a)
  if (n > 0) return fmtBig(n)
  return wfAgentLive(a) ? '—' : '0'
}
function wfTickLive() {
  if (!WF.open || document.hidden) return
  const body = $('tpBody')
  if (!body) return
  for (const r of WF.runs.values()) {
    const card = body.querySelector(`[data-wf-run="${CSS.escape(r.run_id)}"]`)
    if (!card) continue
    const runDur = card.querySelector('[data-wf-dur="run"]')
    if (runDur) runDur.textContent = wfFmtDur(wfElapsed(r))
    for (const a of r.agents || []) {
      const key = a.agent_id || a.label
      if (!key) continue
      const row = card.querySelector(`[data-wf-agent="${CSS.escape(key)}"]`)
      if (!row) continue
      const tm = row.querySelector('.tm')
      const tok = row.querySelector('.tok')
      if (tm) tm.textContent = wfFmtDur(wfAgentDur(a))
      if (tok) tok.textContent = wfFmtTok(a)
    }
  }
}
function wfRender() {
  if (!WF.open) return
  const body = $('tpBody')
  body.innerHTML = ''
  const runs = [...WF.runs.values()]
  const running = runs.filter((r) => !/^(complete|failed|cancelled|interrupted|cleared)$/.test(r.status))
  const finished = runs.filter((r) => /^(complete|failed|cancelled|interrupted)$/.test(r.status))
  if (running.length) body.append(el('div', 'tp-sect', t('Running tasks')))
  for (const r of running) body.append(wfCard(r, true))
  const foot = el('div', 'tp-foot')
  const fin = el('span', 'fin', `${t('Finished')} ${finished.length}`)
  foot.append(fin)
  if (finished.length) {
    const clear = el('button', 'tp-clear', t('Clear'))
    clear.addEventListener('click', () => {
      for (const r of finished) WF.runs.delete(r.run_id)
      wfRender()
    })
    foot.append(clear)
  }
  body.append(foot)
  if (!running.length && finished.length) {
    for (const r of finished.slice(-3)) body.append(wfCard(r, false))
  }
}
function wfCard(r, live) {
  const card = el('div', 'tp-card')
  card.dataset.wfRun = r.run_id
  const h = el('div', 'c-top')
  h.append(el('span', 'name', r.name || r.run_id))
  if (live) {
    const stop = el('button', 'tp-stop', '□')
    stop.title = t('Stop this workflow')
    stop.addEventListener('click', () => {
      const sid = r.sessionId || S.active?.sessionId
      if (!sid) { toast(t('No active session')); return }
      const agentIds = (r.agents || []).map((a) => a.agent_id).filter(Boolean)
      stop.disabled = true
      api('workflow:stop', { sessionId: sid, runId: r.run_id, name: r.name, agentIds })
        .then((res) => {
          if (res?.skipped) toast(t('Sent stop — waiting for the workflow to wind down'))
        })
        .catch((err) => { toast(err.message); stop.disabled = false })
      if (sendingSessions.has(sid)) requestCancel(sid)
    })
    h.append(stop)
  }
  card.append(h)
  const runSub = el('div', 'c-sub')
  runSub.append(document.createTextNode(`${t('Workflow')}  `))
  const runDur = el('span', null, wfFmtDur(wfElapsed(r)))
  runDur.dataset.wfDur = 'run'
  runSub.append(runDur)
  card.append(runSub)
  const agents = r.agents || []
  const tok = agents.reduce((a2, x) => a2 + wfTokNum(x), 0)
  const liveUnknownTok = tok === 0 && agents.some(wfAgentLive)
  card.append(el('div', 'c-sub strong', liveUnknownTok
    ? `${r.agents_used ?? agents.length} ${t('agents')}`
    : `${r.agents_used ?? agents.length} ${t('agents')}  ${fmtBig(tok)} ${t('tokens')}`))
  if (r.objective) card.append(el('div', 'c-obj', r.objective))
  const phases = r.phases || []
  if (phases.length) {
    card.append(el('div', 'c-lab', t('Phases')))
    const done = phases.filter((p) => p.state === 'complete' || p.state === 'done').length
    const ph = el('div', 'c-phase')
    const row = el('div', 'p-row')
    row.append(el('span', 'p-name', r.current_phase || phases[done]?.title || phases[0].title))
    row.append(el('span', 'p-count', `${Math.min(done + 1, phases.length)}/${phases.length}`))
    ph.append(row)
    const dots = el('div', 'p-dots')
    for (const p of phases) {
      const d = el('span', 'pd')
      if (p.state === 'complete' || p.state === 'done') d.classList.add('done')
      else if (p.title === r.current_phase) d.classList.add('cur')
      dots.append(d)
    }
    ph.append(dots)
    card.append(ph)
  }
  if (agents.length) {
    const tbl = el('div', 'c-agents')
    const hd = el('div', 'a-row hd')
    for (const [cls, txt] of [['chk', ''], ['lbl', t('Agent')], ['mdl', t('Model')], ['tok', t('Tokens')], ['tm', t('Time')]]) {
      hd.append(el('span', cls, txt))
    }
    tbl.append(hd)
    for (const a of agents) {
      const row = el('div', 'a-row' + (a.state === 'running' || a.state === 'active' ? ' live' : ''))
      const agentKey = a.agent_id || a.label
      if (agentKey) row.dataset.wfAgent = agentKey
      row.append(el('span', 'chk', (a.state === 'running' || a.state === 'active') ? '' : a.state === 'failed' ? '✗' : '✓'))
      row.append(el('span', 'lbl', a.label || a.agent_id))
      row.append(el('span', 'mdl', a.model || ''))
      row.append(el('span', 'tok', wfFmtTok(a)))
      row.append(el('span', 'tm', wfFmtDur(wfAgentDur(a))))
      tbl.append(row)
    }
    card.append(tbl)
  }
  if (r.result_summary) card.append(el('div', 'c-obj', r.result_summary))
  if (r.pause_message) card.append(el('div', 'c-obj err', r.pause_message))
  return card
}

$('btnNew').addEventListener('click', () => {
  S.active = null
  showHome()
  inputEl.focus()
})

$('btnTerminal').addEventListener('click', () => {
  api('terminal:open', {
    cwd: S.active?.cwd || S.settings?.workspace?.lastCwd || null,
    resumeSessionId: S.active?.sessionId || null,
  }).then(() => toast(t('Opened grok TUI in Terminal'))).catch((e) => toast(e.message))
})

$('btnSettings').addEventListener('click', () => openSettings())

function buildAppearanceSeg() {
  const seg = el('span', 'seg')
  const cur = S.settings.ui.theme || 'system'
  for (const [v, icon, tip] of [['system', '🖥', t('Follow system')], ['light', '☀', t('Light')], ['dark', '🌙', t('Dark')]]) {
    const b = el('button', cur === v ? 'cur' : '', icon)
    b.title = tip
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      S.settings.ui.theme = v
      applyTheme(v)
      api('settings:set', { ui: { theme: v } }).catch(() => {})
      for (const sib of seg.children) sib.classList.remove('cur')
      b.classList.add('cur')
    })
    seg.append(b)
  }
  return seg
}

function applyTheme(pref) {
  if (pref === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
  else if (pref === 'light') document.documentElement.setAttribute('data-theme', 'light')
  else document.documentElement.removeAttribute('data-theme')
}

function fmtReset(endIso) {
  if (!endIso) return ''
  const ms = new Date(endIso).getTime() - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return t('Resetting soon')
  const totalMin = Math.round(ms / 60e3)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h >= 48) {
    const d = new Date(endIso)
    const loc = I18N.lang === 'zh' ? 'zh-CN' : 'en-US'
    const wd = d.toLocaleDateString(loc, { weekday: 'short' })
    const tm = d.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit', hour12: false })
    return t('Resets {0} {1}', wd, tm)
  }
  if (h > 0) return m === 0 ? t('Resets in {0}h', h) : t('Resets in {0}h {1}m', h, m)
  return t('Resets in {0}m', m)
}

const ACCT = { data: null, at: 0, inflight: null }
function prefetchAccount(force) {
  if (ACCT.inflight) return ACCT.inflight
  if (!force && ACCT.data && Date.now() - ACCT.at < 60e3) return Promise.resolve(ACCT.data)
  ACCT.inflight = (async () => {
    try {
      const a = await api('account:get').catch(() => ({ loggedIn: false }))
      const [live, sub, st] = a.loggedIn
        ? await Promise.all([
            api('account:info-live').catch(() => null),
            api('account:subscription').catch(() => null),
            api('stats:get').catch(() => null),
          ])
        : [null, null, null]
      if (!ACCT.data || sub || live) {
        ACCT.data = { a, live, sub, st }
        ACCT.at = Date.now()
      }
    } finally {
      ACCT.inflight = null
    }
    return ACCT.data
  })()
  return ACCT.inflight
}

const UL = { b: null, rule: null, at: 0, lastErr: null, inflight: null, wantDeep: false }
function prefetchUsage(force, { deep = false } = {}) {
  if (UL.inflight && (!force || (deep && UL.wantDeep))) return UL.inflight
  if (!force && UL.b && Date.now() - UL.at < 60e3) return Promise.resolve(UL)
  UL.wantDeep = !!deep
  const p = (async () => {
    try {
      const [b, ruleWrap] = await Promise.all([
        api('usage:get', { deep: !!deep }),
        api('usage:topup-rule').catch(() => null),
      ])
      UL.b = b
      UL.rule = ruleWrap?.rule || null
      UL.at = Date.now()
      UL.lastErr = null
    } catch (e) {
      UL.lastErr = e.message
    } finally {
      if (UL.inflight === p) UL.inflight = null
    }
    return UL
  })()
  UL.inflight = p
  return p
}

async function renderUsageLimits(host, { headHost } = {}) {
  const loading = el('div', 'hint', t('Fetching subscription usage from the engine…'))
  const paint = () => {
    const b = UL.b
    if (!b || !host.isConnected) return false
    const cfg = b.config || {}
    const accts = Array.isArray(b._accounts) ? b._accounts : []
    const separate = planUsageMode() === 'separate' && accts.length > 1
    const sect = el('div', 'ul-sect')
    const head = el('div', 'ul-head')
    head.append(el('span', 't', t('Plan usage limits')))
    const tier = b.subscription_tier || b.subscriptionTier
    if (tier) head.append(el('span', 'plan', tier))
    if (accts.length > 1) head.append(buildPlanUsageSeg(paint))
    if (!headHost) sect.append(head)
    if (accts.length > 1) {
      sect.append(el('div', 'hint', separate
        ? t('One bar per signed-in account. When one hits its limit, the next is used automatically.')
        : t('Combined across {0} signed-in Grok accounts. When one hits its limit, the next is used automatically.', b._mergedCount || accts.length)))
    }

    const bar = (name, resetTxt, pct, who) => {
      const row = el('div', 'ul-row')
      const lab = el('div', 'ul-lab')
      lab.append(el('div', 'n', name))
      if (who) lab.append(el('div', 'who', who))
      if (resetTxt) lab.append(el('div', 'r', resetTxt))
      const track = el('div', 'ul-bar')
      const fill = el('div')
      fill.style.width = pct == null ? '0%' : `${Math.max(0, Math.min(100, pct))}%`
      track.append(fill)
      const pctLabel = pct == null ? '—' : `${Math.round(pct)}% ${t('used')}`
      row.append(lab, track, el('div', 'ul-pct', pctLabel))
      sect.append(row)
    }

    const limitRows = planLimitRows(b).filter((r) => r.name !== t('On-demand'))
    if (limitRows.length) {
      for (const r of limitRows) bar(r.name, r.reset, r.pct, r.who)
    } else {
      sect.append(el('div', 'hint', t('The backend did not return a usage percentage.')))
    }

    const usd = (cent) => `$${(((cent && cent.val) || 0) / 100).toFixed(2)}`
    if (!separate && cfg.used?.val != null && cfg.monthlyLimit?.val) {
      sect.append(el('div', 'hint', `${t('Included credits used')}: ${usd(cfg.used)} / ${usd(cfg.monthlyLimit)}`))
    }

    const odCap = cfg.onDemandCap?.val || 0
    const odUsed = cfg.onDemandUsed?.val || 0
    const odEnabled = b.on_demand_enabled ?? b.onDemandEnabled
    if (odEnabled && odCap > 0) {
      bar(t('On-demand'), `${usd(cfg.onDemandUsed)} / ${usd(cfg.onDemandCap)}`, (odUsed / odCap) * 100)
    }
    const prepaid = cfg.prepaidBalance?.val || 0
    if (prepaid > 0) sect.append(el('div', 'hint', `${t('Prepaid balance')}: ${usd(cfg.prepaidBalance)}`))

    const rule = UL.rule
    if (rule?.enabled) {
      let txt = `${t('Auto top-up')}: +${usd(rule.topupAmount)} ${t('when balance falls below')} ${usd(rule.minBeforeHittingSl)}`
      if (rule.maxAmountPerMonth?.val) txt += `（${t('monthly cap')} ${usd(rule.maxAmountPerMonth)}）`
      sect.append(el('div', 'hint', txt))
    }

    const history = Array.isArray(cfg.history) ? cfg.history.slice(-6).reverse() : []
    if (history.length) {
      sect.append(el('div', 'ul-hist-title', t('Past billing periods')))
      for (const h of history) {
        const cyc = h.billingCycle ? `${h.billingCycle.year}-${String(h.billingCycle.month).padStart(2, '0')}` : '—'
        sect.append(el('div', 'hint mono',
          `${cyc}   ${t('included')} ${usd(h.includedUsed)} · ${t('on-demand')} ${usd(h.onDemandUsed)} · ${t('total')} ${usd(h.totalUsed)}`))
      }
    }
    host.replaceChildren(sect)
    if (headHost) headHost.replaceChildren(head)
    return true
  }
  if (!paint()) host.append(loading)
  await prefetchUsage(true, { deep: true })
  if (!host.isConnected) return
  loading.remove()
  if (!paint()) {
    host.append(el('div', 'hint', `${t('Failed to fetch usage')}: ${UL.lastErr || ''} ${t('(open this page again once the engine is ready)')}`))
  }
}

function openSettings(initialTab) {
  const host = $('modalHost')
  host.innerHTML = ''
  const mask = el('div', 'modal-mask')
  const win = el('div', 'settings-win')
  win.setAttribute('aria-modal', 'true')
  win.setAttribute('role', 'dialog')

  const nav = el('div', 'set-nav')
  const pane = el('div', 'set-pane')
  const tabs = [
    ['general', t('General')],
    ['account', t('Account')],
    ['usage', t('Usage')],
    ['perm', t('Permissions')],
    ['provider', t('Providers')],
    ['data', t('Data')],
    ['about', t('About')],
  ]
  nav.append(el('div', 'n-title', t('Settings')))
  const navBtns = new Map()
  for (const [id, label] of tabs) {
    const b = el('button', null, label)
    b.addEventListener('click', () => selectTab(id))
    nav.append(b)
    navBtns.set(id, b)
  }

  const close = () => { hideHeatTip(); host.innerHTML = '' }
  function selectTab(id) {
    hideHeatTip()
    for (const [tid, b] of navBtns) b.classList.toggle('cur', tid === id)
    pane.innerHTML = ''
    const closeBtn = el('button', 'set-close', '✕')
    closeBtn.addEventListener('click', close)
    pane.append(closeBtn)
    const body = el('div', 'set-body set-body-' + id)
    pane.append(body)
    PANES[id](body)
  }

  const row = (parent, labText, descText, control) => {
    const r = el('div', 'set-row')
    const lab = el('div', 'lab')
    lab.append(el('div', null, labText))
    if (descText) lab.append(el('div', 'd', descText))
    r.append(lab, control)
    parent.append(r)
    return r
  }

  const PANES = {
    async general(p) {
      const prof = S.settings.profile || (S.settings.profile = {})
      const saveProfile = (patch) => {
        Object.assign(prof, patch)
        api('settings:set', { profile: patch }).catch(() => {})
      }

      p.append(el('h2', null, t('Profile')))

      const acct = await api('account:get').catch(() => null)
      const avatar = el('div', 'acct-avatar')
      const setInitial = () => {
        const src = prof.fullName || prof.nickname || acct?.name || acct?.email || '?'
        avatar.textContent = String(src).trim().charAt(0).toUpperCase() || '?'
      }
      setInitial()
      row(p, t('Avatar'), null, avatar)

      const nameInput = el('input')
      nameInput.type = 'text'
      nameInput.value = prof.fullName || ''
      nameInput.addEventListener('change', () => { saveProfile({ fullName: nameInput.value.trim() || null }); setInitial() })
      row(p, t('Full name'), null, nameInput)

      const nickInput = el('input')
      nickInput.type = 'text'
      nickInput.value = prof.nickname || ''
      nickInput.addEventListener('change', () => { saveProfile({ nickname: nickInput.value.trim() || null }); setInitial() })
      row(p, t('What should Grok call you?'), null, nickInput)

      const workSel = el('select')
      const WORKS = ['', 'Engineering', 'Design', 'Product', 'Data science', 'Marketing', 'Writing', 'Education', 'Research', 'Business', 'Other']
      for (const w of WORKS) {
        const o = el('option', null, w ? t(w) : t('Select'))
        o.value = w
        if ((prof.work || '') === w) o.selected = true
        workSel.append(o)
      }
      workSel.addEventListener('change', () => saveProfile({ work: workSel.value || null }))
      row(p, t('What best describes your work?'), null, workSel)

      const instr = el('div', 'profile-instr')
      instr.append(el('div', 'pi-lab', t('Instructions for Grok')))
      instr.append(el('div', 'hint', t('Grok will keep these in mind across chats. Takes effect on new sessions.')))
      const ta = el('textarea')
      ta.rows = 8
      ta.value = prof.instructions || ''
      ta.addEventListener('change', () => saveProfile({ instructions: ta.value.trim() || null }))
      instr.append(ta)
      p.append(instr)

      p.append(el('h2', null, t('Preferences')))
      row(p, t('Appearance'), null, buildAppearanceSeg())
      const keepCb = el('input'); keepCb.type = 'checkbox'
      keepCb.checked = !!S.settings.ui.keepThoughts
      keepCb.addEventListener('change', () => {
        S.settings.ui.keepThoughts = keepCb.checked
        api('settings:set', { ui: { keepThoughts: keepCb.checked } }).catch(() => {})
      })
      row(p, t('Keep thinking transcripts'), t('Off: thinking only shows as “Thinking…” in the status line. On: kept in the transcript, expandable.'), keepCb)

      p.append(el('h2', null, t('While Grok is working')))
      const awakeCb = el('input'); awakeCb.type = 'checkbox'
      awakeCb.checked = S.settings.engine.keepAwake !== false
      awakeCb.addEventListener('change', () => {
        S.settings.engine.keepAwake = awakeCb.checked
        api('settings:set', { engine: { keepAwake: awakeCb.checked } }).catch(() => {})
      })
      row(p, t('Keep working when the display sleeps'),
        t('While a turn is running — or after you blank the screen — the Mac stays awake so Grok can keep going. The screen can still dim, lock, and turn off. Closing the lid or choosing Sleep still pauses the machine. Computer Use needs the display on.'),
        awakeCb)
      const sleepBtn = el('button', 'perm-btn', t('Turn display off now'))
      sleepBtn.addEventListener('click', async () => {
        try {
          await api('display:sleep')
          toast(t('Display off — Grok keeps working'))
        } catch (e) { toast(e.message) }
      })
      row(p, t('Blank the screen'), t('Turns the display off immediately. Same as Energy → Turn Display Off.'), sleepBtn)

      const langSel = el('select')
      for (const [v, label] of [['en', 'English'], ['zh', '中文']]) {
        const o = el('option', null, label)
        o.value = v
        if ((S.settings.ui.language || 'en') === v) o.selected = true
        langSel.append(o)
      }
      langSel.addEventListener('change', async () => {
        S.settings.ui.language = langSel.value
        await api('settings:set', { ui: { language: langSel.value } }).catch(() => {})
        if (S.active) {
          try {
            sessionStorage.setItem('gbd:lastSession', JSON.stringify({
              id: S.active.sessionId, cwd: S.active.cwd, title: S.active.title,
            }))
          } catch {}
        }
        location.reload()
      })
      row(p, t('Language'), t('Applies after reload'), langSel)
    },
    async usage(p) {
      const headHost = el('div')
      const main = el('div', 'ul-main')
      const limitsHost = el('div')
      const cardHost = el('div')
      p.append(headHost, main)
      main.append(limitsHost, cardHost)
      await Promise.all([renderUsageLimits(limitsHost, { headHost }), renderStatsInto(cardHost)])
    },
    async account(p) {
      let data = ACCT.data
      if (!data) data = await prefetchAccount()
      else prefetchAccount()
      const { a, live, sub, st } = data || { a: { loggedIn: false } }
      const meta = sub?.meta || null
      const tier = meta?.subscription_tier || meta?.subscriptionTier || null

      if (a.loggedIn) {
        const hero = el('div', 'prof-hero')
        const nameSrc = String(a.name || a.email || '?').trim()
        const parts = nameSrc.split(/\s+/).filter(Boolean)
        const initials = (parts.length >= 2
          ? parts[0][0] + parts[1][0]
          : String(parts[0] || '?').slice(0, 2)).toUpperCase()
        hero.append(el('div', 'prof-avatar', initials))
        hero.append(el('div', 'prof-name', a.name || a.email))
        const handle = el('div', 'prof-handle')
        handle.append(el('span', 'mail', a.email || ''))
        if (tier) {
          handle.append(el('span', 'dot', '·'))
          handle.append(el('span', 'badge', tier))
        }
        hero.append(handle)
        p.append(hero)

        const gate = meta?.gate
        if (gate?.message) {
          p.append(el('div', 'hint err', `⚠ ${gate.message}${gate.url ? `  ${gate.url}` : ''}`))
        }
        const blocked = [
          ...(live?.userBlockedReason ? [live.userBlockedReason] : []),
          ...(live?.teamBlockedReasons || []),
        ]
        if (blocked.length) {
          p.append(el('div', 'hint err', `⚠ ${t('Account restricted')}: ${blocked.join('; ')}`))
        }
        if (!sub) p.append(el('div', 'hint center', t('Subscription details appear once the engine is running.')))

        const all = st?.ranges?.all || {}
        const strip = el('div', 'stat-strip')
        const cellFn = (v, k) => {
          const c = el('div', 'ss-cell')
          c.append(el('div', 'v', v))
          c.append(el('div', 'k', k))
          strip.append(c)
        }
        const fmtChat = (ms) => {
          if (!ms || ms < 60e3) return '—'
          const h = Math.floor(ms / 3600e3)
          const m = Math.round((ms % 3600e3) / 60e3)
          return h > 0 ? `${h}h ${m}m` : `${m}m`
        }
        cellFn(fmtBig(all.tokens ?? 0), t('Lifetime tokens'))
        cellFn(fmtBig(st?.peakSessionTokens ?? 0), t('Peak tokens'))
        cellFn(fmtChat(st?.longestChatMs), t('Longest chat'))
        cellFn(t('{0} days', all.currentStreak ?? 0), t('Current streak'))
        cellFn(t('{0} days', all.longestStreak ?? 0), t('Longest streak'))
        p.append(strip)

        const days = st?.heatmapYear || []
        if (days.length) {
          const taWrap = el('div', 'ta-wrap')
          const taHead = el('div', 'ta-head')
          taHead.append(el('span', 't', t('Token activity')))
          const tog = el('span', 'ta-toggle')
          taHead.append(tog)
          taWrap.append(taHead)
          const gridHost = el('div', 'ta-gridhost')
          taWrap.append(gridHost)
          p.append(taWrap)

          const [y0, m0, d0] = days[0].date.split('-').map(Number)
          const pad = (new Date(y0, m0 - 1, d0).getDay() + 6) % 7
          const tokenVals = days.map((x) => x.tokens || 0)
          const useTok = tokenVals.some((v) => v > 0)
          const counts = useTok ? tokenVals : days.map((x) => x.count || 0)
          const COL = 14
          const loc = I18N.lang === 'zh' ? 'zh-CN' : 'en-US'

          let mode = 'daily'
          const render = () => {
            hideHeatTip()
            gridHost.innerHTML = ''
            let level
            let weekSum = []
            let runAt = []
            if (mode === 'daily') {
              const max = Math.max(1, ...counts)
              level = counts.map((c) => c / max)
            } else if (mode === 'weekly') {
              for (let i = 0; i < counts.length; i++) {
                const w = Math.floor((i + pad) / 7)
                weekSum[w] = (weekSum[w] || 0) + counts[i]
              }
              const wmax = Math.max(1, ...weekSum.map((x) => x || 0))
              level = counts.map((_, i) => (weekSum[Math.floor((i + pad) / 7)] || 0) / wmax)
            } else {
              const total = counts.reduce((s2, c) => s2 + c, 0) || 1
              let run = 0
              level = counts.map((c) => { run += c; runAt.push(run); return run / total })
            }
            const g = el('div', 'ta-grid')
            for (let i = 0; i < pad; i++) g.append(el('span', 'ta-cell empty'))
            for (let i = 0; i < days.length; i++) {
              const v = level[i]
              const lv = v <= 0 ? 0 : v < 0.25 ? 1 : v < 0.5 ? 2 : v < 0.75 ? 3 : 4
              const cel = el('span', 'ta-cell l' + lv)
              const when = fmtHeatDate(days[i].date)
              let tip
              if (mode === 'weekly') {
                const w = Math.floor((i + pad) / 7)
                const mondayI = i - ((i + pad) % 7)
                const weekWhen = fmtHeatDate(days[Math.max(0, mondayI)].date)
                const val = weekSum[w] || 0
                tip = useTok
                  ? t('{0} tokens the week of {1}', fmtHeatNum(val), weekWhen)
                  : t('{0} turns on {1}', val, when)
              } else if (mode === 'cum') {
                const val = runAt[i] || 0
                tip = useTok
                  ? t('{0} tokens through {1}', fmtHeatNum(val), when)
                  : t('{0} turns on {1}', val, when)
              } else {
                const val = counts[i] || 0
                tip = useTok
                  ? t('{0} tokens on {1}', fmtHeatNum(val), when)
                  : t('{0} turns on {1}', val, when)
              }
              bindHeatTip(cel, tip)
              g.append(cel)
            }
            gridHost.append(g)
            const marks = []
            let prevMonth = null
            const weeks = Math.ceil((pad + days.length) / 7)
            for (let w = 0; w < weeks; w++) {
              const idx = Math.max(0, w * 7 - pad)
              const [yy, mm, dd] = days[idx].date.split('-').map(Number)
              if (mm !== prevMonth) {
                prevMonth = mm
                marks.push({ w, text: new Date(yy, mm - 1, dd).toLocaleDateString(loc, { month: 'short' }) })
              }
            }
            if (marks.length > 1 && marks[1].w - marks[0].w < 3) marks.shift()
            const labels = el('div', 'ta-months')
            for (const mk of marks) {
              const lab = el('span', null, mk.text)
              lab.style.left = `${mk.w * COL}px`
              labels.append(lab)
            }
            gridHost.append(labels)
          }
          for (const [id, label] of [['daily', t('Daily')], ['weekly', t('Weekly')], ['cum', t('Cumulative')]]) {
            const b = el('button', 'ta-tab' + (mode === id ? ' cur' : ''), label)
            b.addEventListener('click', () => {
              mode = id
              for (const sib of tog.children) sib.classList.toggle('cur', sib === b)
              render()
            })
            tog.append(b)
          }
          render()
        }
      } else {
        const card = el('div', 'card')
        card.append(el('div', 'acct-name', t('Not signed in')))
        card.append(el('div', 'hint', t('Click Sign in below — your browser opens to authorize. Then come back and hit Refresh.')))
        p.append(card)
      }

      const list = Array.isArray(a.accounts) ? a.accounts : []
      if (a.loggedIn) {
      p.append(el('h2', null, t('Signed-in accounts')))
      p.append(el('div', 'hint', t('Quotas add together. When one account hits its plan limit, the next is used automatically.')))
      const listHost = el('div', 'acct-list')
      if (!list.length) {
        listHost.append(el('div', 'hint', a.email || t('Signed in')))
      }
      for (const row of list) {
        const card = el('div', 'acct-card' + (row.active ? ' active' : ''))
        const av = el('div', 'acct-avatar')
        const src = String(row.name || row.email || '?').trim()
        const parts = src.split(/\s+/).filter(Boolean)
        av.textContent = (parts.length >= 2 ? parts[0][0] + parts[1][0] : String(parts[0] || '?').slice(0, 2)).toUpperCase()
        const col = el('div', 'acct-col')
        col.append(el('div', 'acct-name', row.name || row.email || row.id))
        const meta = el('div', 'acct-mail')
        const bits = [row.email]
        if (row.tier) bits.push(row.tier)
        if (row.percent != null) bits.push(`${Math.round(row.percent)}% ${t('used')}`)
        if (row.exhausted) bits.push(t('exhausted'))
        if (row.active) bits.push(t('active'))
        meta.textContent = bits.filter(Boolean).join(' · ')
        col.append(meta)
        card.append(av, col)
        const actions = el('div', 'acct-card-ops')
        if (!row.active) {
          const useBtn = el('button', 'secondary small', t('Use'))
          useBtn.addEventListener('click', async () => {
            useBtn.disabled = true
            try {
              await api('account:activate', { id: row.id })
              resetAfterAccountChange()
              await restoreActiveSession()
              selectTab('account')
            } catch (e) {
              toast(e.message)
              useBtn.disabled = false
            }
          })
          actions.append(useBtn)
        }
        const rmBtn = el('button', 'danger small', t('Remove'))
        rmBtn.addEventListener('click', async () => {
          if (rmBtn.dataset.armed !== '1') {
            rmBtn.dataset.armed = '1'
            rmBtn.textContent = t('Confirm remove?')
            setTimeout(() => { rmBtn.dataset.armed = ''; rmBtn.textContent = t('Remove') }, 3000)
            return
          }
          try {
            const next = await api('account:remove', { id: row.id })
            resetAfterAccountChange()
            if (!next?.loggedIn) {
              toast(t('Signed out; engine stopped'))
              close()
              showLoginView()
              return
            }
            toast(t('Removed {0}', row.email || row.id))
            if (row.active) await restoreActiveSession()
            selectTab('account')
          } catch (e) { toast(e.message) }
        })
        actions.append(rmBtn)
        card.append(actions)
        listHost.append(card)
      }
      p.append(listHost)
      }

      const ops = el('div', 'card')
      ops.append(el('h3', null, t('Actions')))
      const opsRow = el('div', 'acct-ops')
      const loginBtn = el('button', 'secondary small', a.loggedIn ? t('Add account') : t('Sign in (grok login)'))
      loginBtn.addEventListener('click', () => {
        api('account:login-start')
          .then(() => toast(t('Browser opened — hit Refresh when done')))
          .catch((e) => toast(e.message))
      })
      const refreshBtn = el('button', 'secondary small', t('Refresh'))
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true
        await prefetchAccount(true).catch(() => {})
        selectTab('account')
      })
      opsRow.append(loginBtn, refreshBtn)
      if (a.loggedIn) {
        const outBtn = el('button', 'danger small', t('Sign out all'))
        outBtn.addEventListener('click', async () => {
          if (outBtn.dataset.armed !== '1') {
            outBtn.dataset.armed = '1'
            outBtn.textContent = t('Confirm sign-out all? (stops the engine)')
            setTimeout(() => { outBtn.dataset.armed = ''; outBtn.textContent = t('Sign out all') }, 3000)
            return
          }
          try {
            await api('account:logout')
            resetAfterAccountChange()
            toast(t('Signed out; engine stopped'))
            close()
            showLoginView()
          } catch (e) { toast(`${t('Sign out failed')}: ${e.message}`) }
        })
        opsRow.append(outBtn)
      }
      ops.append(opsRow)
      p.append(ops)
    },
    perm(p) {
      p.append(el('h2', null, t('Permissions')))
      const sel = el('select')
      for (const [v, label] of Object.entries(PERM_LABELS)) {
        const o = el('option', null, t(label)); o.value = v
        if ((S.settings.engine.permissionMode || 'ask') === v) o.selected = true
        sel.append(o)
      }
      sel.addEventListener('change', () => {
        api('permission:set-mode', { mode: sel.value }).catch((e) => toast(e.message))
        S.settings.engine.permissionMode = sel.value
        updateMeta()
      })
      row(p, t('Permission mode'), t('Note: while ~/.grok/config.toml has permission_mode="always-approve", grok never sends permission requests; remove that line to let this app take over approvals.'), sel)

      // ---- Computer Use ----
      p.append(el('h2', null, t('Computer Use')))
      const cuCb = el('input'); cuCb.type = 'checkbox'
      cuCb.checked = !!S.settings.engine.computerUse
      const cuBlock = el('div', 'cu-block')
      const cuStatus = el('div', 'cu-status')

      const renderCuStatus = async () => {
        cuStatus.textContent = t('Checking permissions…')
        cuStatus.classList.add('checking')
        let pr
        try { pr = await api('computer-use:probe') } catch (e) { cuStatus.textContent = e.message; return }
        cuStatus.classList.remove('checking')
        cuStatus.innerHTML = ''
        if (!pr.available) {
          cuStatus.append(el('div', 'cu-err', t('computer-use/ folder is missing from the app.')))
          return
        }
        const line = (state, label, hint, which) => {
          const cls = state === true ? 'ok' : state === false ? 'bad' : 'unk'
          const d = el('div', 'cu-perm ' + cls)
          d.append(el('span', 'cu-icon', state === true ? '✓' : state === false ? '✗' : '?'))
          const text = el('div', 'cu-perm-text')
          text.append(el('div', 'cu-perm-label', label))
          if (state !== true) {
            text.append(el('div', 'cu-perm-hint',
              state === false ? hint : t('unknown (input helper not built yet)')))
          }
          d.append(text)
          if (state !== true && which) {
            const b = el('button', 'secondary small', t('Open Settings'))
            b.addEventListener('click', () => api('computer-use:open-privacy', { which }).catch(() => {}))
            d.append(b)
          }
          cuStatus.append(d)
        }
        line(pr.screenRecording, t('Screen Recording (screenshots)'),
          t('not granted — grant the host app, then restart it'), 'screen')
        line(pr.accessibility, t('Accessibility (mouse & keyboard)'),
          t('not granted — grant the host app, then restart it'), 'accessibility')
        if (pr.grokAlwaysApprove) {
          cuStatus.append(el('div', 'cu-warn',
            t('~/.grok/config.toml is set to always-approve, so every click and keystroke runs with no confirmation. Remove that line to get approval prompts.')))
        }
        if (pr.display) {
          cuStatus.append(el('div', 'cu-meta mono',
            `${t('Screen')}: ${pr.display.pointsW}×${pr.display.pointsH} pt @${pr.display.scale}x`))
        }
        if (!pr.binaryReady) {
          cuStatus.append(el('div', 'cu-meta', t('Input helper not compiled yet — it builds automatically on first use (needs Xcode command line tools).')))
        }
        const mid = String(S.currentModelId || S.settings.engine.model || '')
        if (mid && !/grok-4\.6|grok-[5-9]/i.test(mid)) {
          cuStatus.append(el('div', 'cu-warn',
            `${t('Current model')} ${mid} — ${t('cannot see screenshots. Switch to Grok 4.6, or Computer Use runs blind.')}`))
        }
      }

      cuCb.addEventListener('change', async () => {
        try {
          await api('settings:set', { engine: { computerUse: cuCb.checked } })
          S.settings.engine.computerUse = cuCb.checked
          toast(cuCb.checked
            ? t('Computer Use on — start a NEW chat for Grok to get the tools')
            : t('Computer Use off — start a NEW chat to drop the tools'))
          if (cuCb.checked) await api('computer-use:prewarm').catch(() => {})
          renderCuStatus()
        } catch (e) { toast(e.message); cuCb.checked = !cuCb.checked }
      })
      row(cuBlock, t('Let Grok control this Mac'),
        t('Grok can take screenshots and move the mouse / type on your behalf. Tools arrive at session start, so toggling only affects NEW chats. Requires macOS Screen Recording + Accessibility permission for whichever app launched this one.'),
        cuCb)
      cuBlock.append(cuStatus)
      p.append(cuBlock)
      renderCuStatus()
    },
    provider(p) {
      p.append(el('h2', null, t('Third-party providers (OpenAI-compatible / xAI proxy)')))
      const provName = el('input'); provName.type = 'text'; provName.placeholder = 'e.g. xinyuanai'
      const provUrl = el('input'); provUrl.type = 'text'; provUrl.placeholder = 'https://…/v1'
      const provKeyEnv = el('input'); provKeyEnv.type = 'text'; provKeyEnv.placeholder = 'e.g. XINYUANAI_API_KEY'
      const provKeyVal = el('input'); provKeyVal.type = 'password'; provKeyVal.placeholder = t('Written to .credentials.yaml (0600), never shown again')
      const active = S.settings.providers?.active
      if (active && S.settings.providers[active]) {
        provName.value = active
        provUrl.value = S.settings.providers[active].baseURL || ''
        provKeyEnv.value = S.settings.providers[active].apiKeyEnv || ''
      }
      row(p, t('Route id'), t('Permanent identity, also the config key'), provName)
      row(p, 'Base URL', t('Leave empty to use official grok (signed in)'), provUrl)
      row(p, t('Key name'), t('Only this name is stored in config'), provKeyEnv)
      row(p, t('Key value'), t('Written to .credentials.yaml (0600), never shown again'), provKeyVal)
      const saveProv = el('button', 'perm-btn allow', t('Save & restart engine'))
      saveProv.addEventListener('click', async () => {
        try {
          const id = provName.value.trim()
          if (!provUrl.value.trim()) {
            await api('settings:set', { providers: { active: null } })
            S.settings.providers.active = null
          } else {
            if (!id) throw new Error(t('Fill in the route id first'))
            const keyEnv = provKeyEnv.value.trim()
            if (provKeyVal.value.trim()) {
              if (!keyEnv) throw new Error(t('Fill in the key name first'))
              await api('credentials:set', { name: keyEnv, value: provKeyVal.value.trim() })
            }
            const patch = { providers: { active: id } }
            patch.providers[id] = { baseURL: provUrl.value.trim(), apiKeyEnv: keyEnv || null }
            await api('settings:set', patch)
            S.settings.providers = { ...S.settings.providers, ...patch.providers }
          }
          await api('engine:start', {})
          await restoreActiveSession()
          toast(t('Saved; engine restarted'))
          close()
        } catch (err) { toast(err.message) }
      })
      const r = el('div', 'set-row')
      r.append(el('div', 'lab'), saveProv)
      p.append(r)
    },
    data(p) {
      p.append(el('h2', null, t('Data')))
      const b1 = el('button', 'perm-btn', t('Open data folder'))
      b1.addEventListener('click', () => api('app:open-data-dir').catch((e) => toast(e.message)))
      row(p, t('Data folder'), 'prompts / settings.yaml / .credentials.yaml', b1)
      const b2 = el('button', 'perm-btn', t('Open logs'))
      b2.addEventListener('click', () => api('app:open-logs').catch((e) => toast(e.message)))
      row(p, t('Logs'), t('Daily files, secrets masked before writing, auto-cleaned after 7 days'), b2)
      const b3 = el('button', 'perm-btn', t('README'))
      b3.addEventListener('click', () => api('app:open-readme').catch((e) => toast(e.message)))
      row(p, t('User guide'), t('Documentation file'), b3)
    },
    about(p) {
      p.append(el('h2', null, t('About')))
      const meta = S.initInfo?._meta || {}
      const info = [
        [t('App'), 'Grok Build Desktop'],
        [t('Engine'), `grok ${meta.agentVersion || '—'}`],
        [t('Current model'), modelDisplay(S.currentModelId)],
        [t('Protocol'), 'ACP over stdio (JSON-RPC 2.0)'],
      ]
      for (const [k, v] of info) row(p, k, null, el('span', null, v))
      const quit = el('button', 'perm-btn deny', t('Quit Grok Build'))
      quit.addEventListener('click', () => api('app:quit'))
      row(p, t('Quit'), null, quit)
    },
  }

  win.append(nav, pane)
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close() })
  mask.append(win)
  host.append(mask)
  selectTab(initialTab || 'general')
}

async function renderStatsInto(host) {
  let data
  try { data = await api('stats:get') } catch { host.textContent = t('Stats unavailable'); return }
  host.innerHTML = ''
  const card = el('div', 'stats-card')

  const head = el('div', 'stats-head')
  head.append(el('span', 'tab', t('Overview')), el('span', 'grow'))
  for (const [key, label] of [['all', t('All')], ['d30', t('30 days')], ['d7', t('7 days')]]) {
    const b = el('button', 'range-btn' + (S.statsRange === key ? ' cur' : ''), label)
    b.addEventListener('click', () => { S.statsRange = key; renderStatsInto(host) })
    head.append(b)
  }
  card.append(head)

  const t2 = window.t
  const tt = data.ranges[S.statsRange] || data.ranges.all
  const tiles = el('div', 'tiles')
  const ranged = S.statsRange !== 'all'
  const tileDefs = [
    [t2('Sessions'), String(tt.sessions)],
    ranged ? [t2('Turns'), fmtBig(tt.turns)] : [t2('Messages'), fmtBig(tt.messages)],
    [t2('Total tokens'), fmtBig(tt.tokens)],
    [t2('Active days'), String(tt.activeDays)],
    [t2('Current streak'), tt.currentStreak ? t2('{0} days', tt.currentStreak) : '—'],
    [t2('Longest streak'), tt.longestStreak ? t2('{0} days', tt.longestStreak) : '—'],
    [t2('Peak hour'), tt.peakHour != null ? t2('{0}:00', tt.peakHour) : '—'],
    [t2('Favorite model'), tt.favoriteModel ? modelDisplay(tt.favoriteModel) : '—'],
  ]
  for (const [k, v] of tileDefs) {
    const tile = el('div', 'tile')
    tile.append(el('div', 'k', k), el('div', 'v', v))
    tiles.append(tile)
  }
  card.append(tiles)

  const days = data.heatmap || []
  if (days.length) {
    const hm = el('div', 'heatmap')
    const firstDow = (new Date(days[0].date + 'T12:00:00').getDay() + 6) % 7
    const cells = Array(firstDow).fill(null).concat(days)
    const maxTok = Math.max(0, ...days.map((d) => d.tokens || 0))
    let col = null
    cells.forEach((c, i) => {
      if (i % 7 === 0) { col = el('div', 'hm-col'); hm.append(col) }
      const cell = el('div', 'hm-cell')
      if (c) {
        const n = c.count
        if (maxTok > 0) {
          const r = (c.tokens || 0) / maxTok
          if (r > 0) cell.classList.add(r < 0.25 ? 'l1' : r < 0.5 ? 'l2' : r < 0.75 ? 'l3' : 'l4')
        } else if (n > 0) {
          cell.classList.add(n <= 2 ? 'l1' : n <= 5 ? 'l2' : n <= 10 ? 'l3' : 'l4')
        }
        const when = fmtHeatDate(c.date)
        const tip = (c.tokens > 0)
          ? t('{0} tokens on {1}', fmtHeatNum(c.tokens), when)
          : t('{0} turns on {1}', n, when)
        bindHeatTip(cell, tip)
      } else {
        cell.style.visibility = 'hidden'
      }
      col.append(cell)
    })
    card.append(hm)
  }

  if (data.funMultiple > 0) {
    card.append(el('div', 'fun-line',
      t('You’ve burned roughly ~{0}× the tokens of the entire first Harry Potter book.', fmtBig(data.funMultiple))))
  }
  host.append(card)
}

function applyStaticI18n() {
  document.documentElement.lang = I18N.lang === 'zh' ? 'zh' : 'en'
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n)
  for (const n of document.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle)
  for (const n of document.querySelectorAll('[data-i18n-ph]')) n.placeholder = t(n.dataset.i18nPh)
}

let loginPoll = null
let loginPollUntil = 0
function stopLoginPoll() {
  clearInterval(loginPoll)
  loginPoll = null
  loginPollUntil = 0
}
function loginPollTick() {
  if (document.hidden) return
  if (loginPollUntil && Date.now() > loginPollUntil) {
    stopLoginPoll()
    $('loginHint').textContent = t('Still not signed in — finish the authorization in your browser first')
    return
  }
  api('account:get').then((a) => { if (a?.loggedIn) hideLoginViewAndContinue() }).catch(() => {})
}
function armLoginPoll() {
  if (loginPoll) return
  if (!loginPollUntil) loginPollUntil = Date.now() + 10 * 60_000
  loginPoll = setInterval(loginPollTick, 3000)
}
function showLoginView() {
  setGrokLoad(false)
  $('loginView').hidden = false
}
function hideLoginViewAndContinue() {
  stopLoginPoll()
  $('loginView').hidden = true
  finishBoot()
}
$('loginBtn').addEventListener('click', () => {
  const btn = $('loginBtn')
  btn.disabled = true
  api('account:login-start').then(() => {
    $('loginHint').textContent = t('Opened in your browser — finish authorizing there…')
    armLoginPoll()
  }).catch((e) => {
    $('loginHint').textContent = `${t('Sign in failed')}: ${e.message}`
    stopLoginPoll()
  }).finally(() => { btn.disabled = false })
})
document.addEventListener('visibilitychange', () => {
  if (!loginPollUntil) return
  if (document.hidden) {
    clearInterval(loginPoll)
    loginPoll = null
  } else {
    armLoginPoll()
    loginPollTick()
  }
})
$('loginContinue').addEventListener('click', async () => {
  const a = await api('account:get').catch(() => null)
  if (a?.loggedIn) hideLoginViewAndContinue()
  else $('loginHint').textContent = t('Still not signed in — finish the authorization in your browser first')
})
on('evt:account-login-done', async ({ ok } = {}) => {
  if (!ok) {
    $('loginHint').textContent = t('Sign in did not complete — try again')
    return
  }
  const a = await api('account:get').catch(() => null)
  if (!a?.loggedIn) return
  resetAfterAccountChange()
  prefetchAccount(true).catch(() => {})
  prefetchUsage(true, { deep: true }).catch(() => {})
  toast(t('Signed in successfully'))
  if (!$('loginView').hidden) hideLoginViewAndContinue()
})

on('evt:account-switched', ({ to, from, reason, ok = true, error } = {}) => {
  resetAfterAccountChange()
  prefetchAccount(true).catch(() => {})
  prefetchUsage(true, { deep: true }).catch(() => {})
  void from
  if (ok === false) {
    const msg = to
      ? t('Switched to {0}, but the engine did not restart.', to)
      : t('Engine did not restart after switching accounts.')
    toast(error ? `${msg} ${error}` : msg)
    showEngineDownBanner(msg)
    return
  }
  if (reason === 'quota' && to) {
    toast(t('Quota exhausted — switched to {0}', to))
  } else if (to) {
    toast(t('Switched to {0}', to))
  }
  // Main restart does not session/load; idle quota failover has no other restore.
  restoreActiveSession().catch(() => {})
})

function resetAfterAccountChange() {
  ACCT.data = null
  ACCT.at = 0
  ACCT.inflight = null
  UL.b = null
  UL.rule = null
  UL.at = 0
  UL.lastErr = null
  UL.inflight = null
  UL.wantDeep = false
}

async function boot() {
  if (!window.grokDesktop) {
    document.body.textContent = t('This page must run inside Grok Build Desktop (Electron).')
    return
  }
  S.settings = await api('settings:get')
  I18N.setLang(S.settings.ui?.language || 'en')
  applyStaticI18n()
  applyTheme(S.settings.ui.theme || 'system')
  applyUiPrefs()
  S.currentEffort = S.settings.engine.effort || null

  const acct = await api('account:get').catch(() => ({ loggedIn: true }))
  if (!acct.loggedIn) {
    showLoginView()
    return
  }
  await finishBoot()
}

async function finishBoot() {
  try { S.presets = await api('presets:list') } catch {}
  updateMeta()
  showHome()
  startHeroTyper()

  const info = await api('engine:info')
  if (info.running && info.init) {
    S.initInfo = info.init
    const ms = info.init?._meta?.modelState
    if (ms) {
      S.models = ms.availableModels || []
      S.currentModelId = S.settings.engine.model || ms.currentModelId
    }
    S.cmdsFresh = false
    if (info.init?._meta?.availableCommands) S.availableCommands = info.init._meta.availableCommands
    setEngineState(true)
    updateMeta()
  }
  if (!info.running) {
    api('engine:start', {}).catch((err) => {
      setEngineState(false)
      toast(`${t('Engine failed to start')}: ${err.message}`)
    })
  }

  prefetchAccount()
  prefetchUsage()
  await refreshSessions()

  if (S.settings?.__loadFailed) {
    const area = $('bannerArea')
    const b = el('div', 'banner')
    b.append(el('span', 'grow',
      `${t('Could not read settings.yaml — using defaults for now. The original file was backed up next to it.')} (${S.settings.__loadFailed})`))
    const x = el('button', null, t('Dismiss'))
    x.addEventListener('click', () => b.remove())
    b.append(x)
    area.append(b)
  }

  let last = null
  try { last = JSON.parse(sessionStorage.getItem('gbd:lastSession') || 'null') } catch {}
  sessionStorage.removeItem('gbd:lastSession')
  if (last?.id && last?.cwd) {
    await openSession({ id: last.id, cwd: last.cwd, title: last.title }).catch(() => {})
  } else {
    setGrokLoad(false)
  }
  inputEl.focus()
}

boot()

;(() => {
  const gear = document.getElementById('btn-settings')
  if (gear) gear.addEventListener('click', () => openSettings())

  const status = document.getElementById('status')
  const statusText = document.getElementById('status-text')
  const engineDot = document.getElementById('engineDot')
  if (!status || !engineDot) return

  const sync = () => {
    if (engineDot.classList.contains('dead')) {
      status.className = 'bad'
      statusText.textContent = t('Stopped')
    } else if (engineDot.classList.contains('busy')) {
      status.className = 'busy'
      statusText.textContent = t('Generating')
    } else {
      status.className = 'ok'
      statusText.textContent = t('Ready')
    }
  }
  new MutationObserver(sync).observe(engineDot, { attributes: true, attributeFilter: ['class'] })
  const origSetEngineState = setEngineState
  // eslint-disable-next-line no-func-assign
  setEngineState = (running) => {
    origSetEngineState(running)
    sync()
  }
})()
