'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const DEFAULT_DOC = {
  version: 1,
  accounts: [],
  blocklist: { projects: [], users: [] },
  settings: {
    notifications: true,
    notifyIntervalSec: 45,
    closeToTray: true,
    revealScope: 'global',
    showPageFab: true,
    autoClearBlockedMail: false
  }
}

// 临时解除只活在内存里：重启后屏蔽自动恢复，不会留下「上次忘记关」的状态
const reveal = { all: false, projectIds: new Set(), userKeys: new Set() }
const listeners = new Set()

let doc = null
let file = null

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function userKeyOf(entry) {
  const id = num(entry && entry.id)
  if (id) return 'id:' + id
  const name = String((entry && entry.username) || '').trim().toLowerCase()
  return name ? 'name:' + name : ''
}

function load() {
  file = path.join(app.getPath('userData'), 'paratranz-desktop.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    doc = {
      version: 1,
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      blocklist: {
        projects: (raw.blocklist && raw.blocklist.projects) || [],
        users: (raw.blocklist && raw.blocklist.users) || []
      },
      settings: Object.assign({}, DEFAULT_DOC.settings, raw.settings || {})
    }
  } catch (e) {
    doc = JSON.parse(JSON.stringify(DEFAULT_DOC))
  }
  return doc
}

function save() {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  emit()
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(snapshot())
    } catch (e) {
      console.error('store listener failed', e)
    }
  }
}

function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function findProject(id) {
  return doc.blocklist.projects.find((p) => num(p.id) === num(id))
}

function findUser(idOrName) {
  const key = userKeyOf({ id: num(idOrName) })
  const byName = userKeyOf({ username: idOrName })
  return doc.blocklist.users.find((u) => userKeyOf(u) === key || userKeyOf(u) === byName)
}

function addProject(entry) {
  const id = num(entry && entry.id)
  if (!id) return { ok: false, error: '无效项目 id' }
  if (findProject(id)) return { ok: false, error: '已在名单中' }
  doc.blocklist.projects.unshift({
    id: id,
    name: String(entry.name || '').slice(0, 200),
    url: String(entry.url || '').slice(0, 500),
    note: String(entry.note || '').slice(0, 500),
    addedAt: Date.now()
  })
  save()
  return { ok: true }
}

function removeProject(id) {
  const before = doc.blocklist.projects.length
  doc.blocklist.projects = doc.blocklist.projects.filter((p) => num(p.id) !== num(id))
  reveal.projectIds.delete(num(id))
  if (doc.blocklist.projects.length !== before) save()
  return { ok: true }
}

function addUser(entry) {
  const id = num(entry && entry.id)
  const username = String((entry && entry.username) || '').trim()
  if (!id && !username) return { ok: false, error: '需要用户 id 或用户名' }
  if (findUser(id || username)) return { ok: false, error: '已在名单中' }
  doc.blocklist.users.unshift({
    id: id || null,
    username: username,
    nickname: String(entry.nickname || '').slice(0, 200),
    url: String(entry.url || '').slice(0, 500),
    note: String(entry.note || '').slice(0, 500),
    addedAt: Date.now()
  })
  save()
  return { ok: true }
}

function removeUser(idOrName) {
  const key = userKeyOf({ id: num(idOrName) }) || userKeyOf({ username: idOrName })
  const before = doc.blocklist.users.length
  doc.blocklist.users = doc.blocklist.users.filter((u) => userKeyOf(u) !== key)
  reveal.userKeys.delete(key)
  if (doc.blocklist.users.length !== before) save()
  return { ok: true }
}

function setRevealAll(on) {
  reveal.all = !!on
  if (!on) {
    reveal.projectIds.clear()
    reveal.userKeys.clear()
  }
  emit()
}

function revealProject(id) {
  const n = num(id)
  if (!n) return
  reveal.projectIds.add(n)
  emit()
}

function revealUser(idOrName) {
  const key = userKeyOf({ id: num(idOrName) }) || userKeyOf({ username: idOrName })
  if (!key) return
  reveal.userKeys.add(key)
  emit()
}

function updateSettings(patch) {
  doc.settings = Object.assign({}, doc.settings, patch || {})
  save()
}

function upsertAccount(account) {
  const id = String(account.id || '')
  if (!id) return { ok: false, error: '需要账号 id' }
  const existing = doc.accounts.find((a) => a.id === id)
  if (existing) Object.assign(existing, { name: account.name || existing.name, lastUsed: Date.now() })
  else doc.accounts.push({ id: id, name: account.name || id, createdAt: Date.now(), lastUsed: Date.now() })
  save()
  return { ok: true }
}

function removeAccount(id) {
  doc.accounts = doc.accounts.filter((a) => a.id !== id)
  save()
}

function snapshot() {
  const pure = require('../shared/pure')
  const raw = {
    projects: doc.blocklist.projects,
    users: doc.blocklist.users,
    reveal: { all: reveal.all, projectIds: Array.from(reveal.projectIds), userKeys: Array.from(reveal.userKeys) },
    clearBlockedMail: doc.settings.autoClearBlockedMail === true,
    showPageFab: doc.settings.showPageFab !== false
  }
  return {
    accounts: doc.accounts,
    settings: doc.settings,
    blocklist: JSON.parse(JSON.stringify(doc.blocklist)),
    reveal: JSON.parse(JSON.stringify(raw.reveal)),
    rulesState: pure.buildRulesState(pure.normalizeRules(raw))
  }
}

module.exports = {
  load,
  onChange,
  addProject,
  removeProject,
  addUser,
  removeUser,
  userKeyOf,
  setRevealAll,
  revealProject,
  revealUser,
  updateSettings,
  upsertAccount,
  removeAccount,
  snapshot,
  file: () => file
}
