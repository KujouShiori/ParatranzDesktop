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
let timer = null
let running = false
let dumpShapes = false

function rulesNow() {
  const snap = store.snapshot()
  return pure.normalizeRules({
    projects: snap.blocklist.projects,
    users: snap.blocklist.users,
    reveal: snap.reveal
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
  if (!entry.primed) {
    for (let i = 0; i < items.length; i++) entry.seen.add(shape.keyOf(items[i], i))
    entry.primed = true
    return
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const id = shape.keyOf(item, i)
    if (entry.seen.has(id)) continue
    entry.seen.add(id)
    if (shape.shouldSkip(item, rules)) continue
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

function schedule() {
  if (timer) clearInterval(timer)
  timer = null
  const snap = store.snapshot()
  running = snap.settings.notifications !== false
  dumpShapes = !!snap.settings.dumpShapes
  if (!running) return
  const seconds = Math.max(15, Number(snap.settings.notifyIntervalSec) || 45)
  timer = setInterval(pollAll, seconds * 1000)
  pollAll()
}

function start() {
  store.onChange(() => schedule())
  schedule()
}

function resetForTests() {
  state.clear()
}

function debugState() {
  const out = {}
  for (const [key, entry] of state) {
    out[key] = { primed: entry.primed, seen: entry.seen.size, status: entry.lastStatus, error: entry.lastError }
  }
  return out
}

module.exports = { start, schedule, pollAll, pollAccountNow, resetForTests, debugState, FEEDS }
