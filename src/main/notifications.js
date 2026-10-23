'use strict'

const fs = require('fs')
const path = require('path')
const { app, Notification } = require('electron')
const pure = require('../shared/pure')
const shape = require('../shared/notify')
const store = require('./store')
const windows = require('./windows')
const tray = require('./tray')

// 匿名实测：/api/broadcasts 返回 []（公开），/api/mails、/api/mails/count、/api/messages 返回 401，
// 说明这三个要登录但路径存在。字段形状只能在登录后确认，因此这里用兼容取值的适配层，
// 并留一个「记录原始结构」开关，跑一次就能拿到真实字段名。
const FEEDS = [
  { id: 'mails', list: '/api/mails?page=1&pageSize=20' },
  { id: 'messages', list: '/api/messages?page=1&pageSize=20' },
  { id: 'broadcasts', list: '/api/broadcasts?page=1&pageSize=20' }
]

const state = new Map()
const cleared = new Map()
let timer = null
let running = false
let dumpShapes = false

function rulesNow() {
  const snap = store.snapshot()
  return pure.normalizeRules({
    projects: snap.blocklist.projects,
    users: snap.blocklist.users,
    reveal: snap.reveal,
    clearBlockedMail: snap.settings.autoClearBlockedMail === true
  })
}

function maybeDump(feedId, account, json) {
  if (!dumpShapes) return
  const dir = path.join(app.getPath('userData'), 'shape-dump')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, feedId + '-' + String(account).replace(/[^\w-]/g, '') + '.json')
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(json, null, 2), 'utf8')
  } catch (e) {
    console.error('dump 失败', e)
  }
}

let unreadCount = 0

// 系统通知容易被错过，所以同时在任务栏上给出痕迹：闪一下 + 角标，
// 窗口被看到之后自动清掉。
function markUnread(account) {
  unreadCount += 1
  for (const win of windows.windowsFor(account)) {
    try {
      win.flashFrame(true)
      win.setOverlayIcon(tray.badgeIcon(), '有未读的新消息')
    } catch (e) {}
    const clear = () => {
      unreadCount = Math.max(0, unreadCount - 1)
      try {
        win.flashFrame(false)
        if (unreadCount === 0) win.setOverlayIcon(null, '')
      } catch (e) {}
    }
    win.once('focus', clear)
    win.once('show', clear)
  }
}

function notify(account, title, body) {
  markUnread(account)
  if (!Notification.isSupported()) {
    console.log('[提醒] ' + title + ' ' + body)
    return
  }
  const n = new Notification({ title: title, body: body, silent: false })
  n.on('click', () => {
    const list = windows.windowsFor(account)
    if (list.length) {
      list[0].show()
      list[0].focus()
    } else {
      windows.createSiteWindow({ account: account })
    }
  })
  n.show()
}

const myIds = new Map()

async function myUidFor(account, ses) {
  if (myIds.has(account)) return myIds.get(account)
  try {
    const res = await ses.fetch('https://paratranz.cn/api/account', { headers: { accept: 'application/json' } })
    const text = (await res.text()).trim()
    if (!text) return null
    const uid = Number(JSON.parse(text).id)
    if (Number.isFinite(uid)) myIds.set(account, uid)
    return Number.isFinite(uid) ? uid : null
  } catch (e) {
    return null
  }
}

// 开关打开时才会走到这里：这是唯一会改动服务器状态的动作（把与该人的会话标记已读），
// 用的是站点自己的接口，效果等同于你在网页上点开那条会话。
async function clearBlockedConversations(account, ses, items, rules) {
  const myId = await myUidFor(account, ses)
  const uids = shape.blockedUnreadConversations(items, rules, myId)
  const done = cleared.get(account) || new Set()
  cleared.set(account, done)
  const results = []
  for (const uid of uids) {
    if (done.has(uid)) continue
    done.add(uid)
    try {
      const res = await ses.fetch('https://paratranz.cn/api/mails/conversations/' + uid, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ op: 'read' })
      })
      results.push({ uid: uid, status: res.status })
    } catch (e) {
      results.push({ uid: uid, error: String(e && e.message ? e.message : e) })
    }
  }
  return results
}

async function pollFeed(account, feed, rules) {
  const key = account + '/' + feed.id
  let entry = state.get(key)
  if (!entry) {
    entry = { seen: new Set(), primed: false, lastStatus: 0 }
    state.set(key, entry)
  }
  const ses = windows.sessionFor(account)
  let json
  try {
    const res = await ses.fetch('https://paratranz.cn' + feed.list, { headers: { accept: 'application/json' } })
    entry.lastStatus = res.status
    if (res.status === 401 || res.status === 403) return
    if (!res.ok) return
    json = await res.json()
  } catch (e) {
    entry.lastError = String(e && e.message ? e.message : e)
    return
  }
  maybeDump(feed.id, account, json)
  const items = shape.itemsOf(json)
  if (feed.id === 'mails' && rules.clearBlockedMail) {
    clearBlockedConversations(account, ses, items, rules).catch((e) => console.error('[提醒] 标记已读失败', account, String(e && e.message ? e.message : e)))
  }
  if (!entry.primed) {
    for (let i = 0; i < items.length; i++) entry.seen.add(shape.keyOf(items[i], i))
    entry.primed = true
    return
  }
  let myId
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const id = shape.keyOf(item, i)
    if (entry.seen.has(id)) continue
    entry.seen.add(id)
    if (shape.shouldSkip(item, rules)) continue
    // 自己发出去的那条只是列表里多了个新条目，不是别人在找我
    if (myId === undefined) myId = await myUidFor(account, ses)
    if (shape.isSelfAuthored(item, myId)) continue
    notify(account, shape.titleOf(item, feed.id), shape.bodyOf(item))
  }
}

async function pollAll() {
  if (!running) return
  const rules = rulesNow()
  const accounts = ['default'].concat((store.snapshot().accounts || []).map((a) => a.id))
  for (const account of accounts) {
    for (const feed of FEEDS) {
      try {
        await pollFeed(account, feed, rules)
      } catch (e) {
        console.error('[提醒] 拉取失败', account, feed.id, String(e && e.message ? e.message : e))
      }
    }
  }
}

// 页面里 socket 推来新事件时调用：稍等一小会儿（让站点的写入落到接口上），
// 然后为该账号把所有源各拉一次，不等下一个轮询周期。
const pending = new Set()

function pollAccountNow(account) {
  const key = String(account)
  if (pending.has(key)) return
  pending.add(key)
  setTimeout(() => {
    pending.delete(key)
    const rules = rulesNow()
    for (const feed of FEEDS) {
      pollFeed(key, feed, rules).catch((e) => console.error('[提醒] 即时拉取失败', key, feed.id, String(e && e.message ? e.message : e)))
    }
  }, 600)
}

// 未读计数探针：比完整列表轻得多，用来把提醒延迟压到几秒；计数涨了才去拉列表。
// 站点没有 CSP、也没有速率限制（实测 30 连发全部 200），所以 5 秒一次是安全的。
const COUNT_PROBES = [{ id: 'mails', path: '/api/mails/count' }]
const FAST_INTERVAL_MS = 5000
const lastCounts = new Map()
let fastTimer = null

function pickCount(json) {
  if (typeof json === 'number') return json
  if (!json || typeof json !== 'object') return null
  for (const key of ['unread', 'count', 'total', 'new', 'noRead', 'number']) {
    if (typeof json[key] === 'number') return json[key]
  }
  return null
}

async function fastProbe() {
  if (!running) return
  const accounts = ['default'].concat((store.snapshot().accounts || []).map((a) => a.id))
  for (const account of accounts) {
    for (const probe of COUNT_PROBES) {
      const key = account + probe.path
      let value = null
      try {
        const res = await windows.sessionFor(account).fetch('https://paratranz.cn/api' + probe.path, { headers: { accept: 'application/json' } })
        if (!res.ok) continue
        value = pickCount(await res.json())
      } catch (e) {
        continue
      }
      if (value === null) continue // 认不出字段就什么都不做，交给完整轮询兜底
      const prev = lastCounts.get(key)
      lastCounts.set(key, value)
      if (prev !== undefined && value > prev) pollAccountNow(account)
    }
  }
}

function schedule() {
  if (timer) clearInterval(timer)
  timer = null
  if (fastTimer) clearInterval(fastTimer)
  fastTimer = null
  const snap = store.snapshot()
  running = snap.settings.notifications !== false
  dumpShapes = !!snap.settings.dumpShapes
  if (!running) return
  const seconds = Math.max(15, Number(snap.settings.notifyIntervalSec) || 45)
  timer = setInterval(pollAll, seconds * 1000)
  fastTimer = setInterval(fastProbe, FAST_INTERVAL_MS)
  pollAll()
  fastProbe()
}

function start() {
  store.onChange(() => schedule())
  schedule()
}

function resetForTests() {
  state.clear()
  cleared.clear()
  myIds.clear()
}

function debugState() {
  const out = {}
  for (const [key, entry] of state) {
    out[key] = { primed: entry.primed, seen: entry.seen.size, status: entry.lastStatus, error: entry.lastError }
  }
  return out
}

module.exports = { start, schedule, pollAll, pollAccountNow, fastProbe, resetForTests, debugState, FEEDS }
