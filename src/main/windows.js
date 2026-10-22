'use strict'

const path = require('path')
const { BrowserWindow, ipcMain, dialog, session, webContents } = require('electron')
const pure = require('../shared/pure')
const injector = require('./injector')
const store = require('./store')

const SITE = 'https://paratranz.cn/'
const PRELOAD = path.join(__dirname, '..', 'preload', 'shield.js')

const registry = new Map()
let focusedAccount = 'default'

function partitionFor(account) {
  return 'persist:pt-' + (account || 'default')
}

function rulesState() {
  return store.snapshot().rulesState
}

let currentRules = pure.normalizeRules({})
let quitting = false
let contextMenuHandler = null

function setContextMenuHandler(fn) {
  contextMenuHandler = fn
}

function setQuitting(on) {
  quitting = !!on
}

function setRules(snapshot) {
  currentRules = pure.normalizeRules({
    projects: snapshot.blocklist.projects,
    users: snapshot.blocklist.users,
    reveal: snapshot.reveal
  })
}

function sessionFor(account) {
  return session.fromPartition(partitionFor(account))
}

function installNetworkBackstop(ses) {
  if (ses.__ptBackstop) return
  ses.__ptBackstop = true
  const { webRequest } = ses
  webRequest.onBeforeRequest({ urls: ['*://paratranz.cn/api/*', '*://*.paratranz.cn/api/*'] }, (details, callback) => {
    const hit = pure.urlTargetsBlockedProject(currentRules, details.url)
    callback(hit ? { cancel: true } : {})
  })
}

function applyContextGuard(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(false)
  })
}

function createSiteWindow(options) {
  const opts = options || {}
  const account = opts.account || 'default'
  focusedAccount = account
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#1e1e1e',
    title: 'Paratranz',
    autoHideMenuBar: false,
    webPreferences: {
      preload: PRELOAD,
      partition: partitionFor(account),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: false,
      devTools: true
    }
  })

  const entry = { win: win, account: account, kind: 'site' }
  registry.set(win.webContents.id, entry)

  const ses = sessionFor(account)
  installNetworkBackstop(ses)
  applyContextGuard(ses)

  const wcId = win.webContents.id
  win.webContents.on('did-finish-load', () => {
    injector.pushRules(win.webContents, rulesState())
    injector.upgradeCdp(win.webContents, rulesState())
  })
  win.on('focus', () => { focusedAccount = account })
  win.on('close', (e) => {
    if (quitting) return
    if (store.snapshot().settings.closeToTray) {
      e.preventDefault()
      win.hide()
      require('./tray').hintHidden()
    }
  })
  win.on('closed', () => {
    registry.delete(wcId)
  })

  guardNavigation(win)
  if (contextMenuHandler) {
    win.webContents.on('context-menu', (event, params) => contextMenuHandler(win, params))
  }

  const target = opts.url || SITE
  injector.install(win.webContents, rulesState()).then(() => {
    if (win.isDestroyed()) return
    win.webContents.loadURL(target)
  })
  return win
}

function guardNavigation(win) {
  const wc = win.webContents
  const denyIfBlocked = (rawUrl, retry) => {
    const hit = pure.urlTargetsBlockedProject(currentRules, rawUrl)
    if (!hit) return false
    const info = pure.parseSiteUrl(rawUrl)
    const label = info.projectId !== null ? '项目 ' + info.projectId : '地址'
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['临时显示', '保持屏蔽'],
      defaultId: 1,
      cancelId: 1,
      title: '已被屏蔽',
      message: label + ' 已被本客户端屏蔽。',
      detail: rawUrl
    })
    if (choice === 0) {
      store.revealProject(hit)
      if (retry) retry()
    }
    return true
  }

  wc.on('will-navigate', (event, url) => {
    if (denyIfBlocked(url, () => {
      event.preventDefault()
      wc.loadURL(url)
    })) event.preventDefault()
  })

  wc.setWindowOpenHandler(({ url }) => {
    if (denyIfBlocked(url, () => { wc.loadURL(url) })) return { action: 'deny' }
    if (/^https:\/\/paratranz\.cn\//.test(url)) {
      createSiteWindow({ url: url, account: registry.get(wc.id) ? registry.get(wc.id).account : 'default' })
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
}

function siteContents() {
  const out = []
  for (const id of registry.keys()) {
    const entry = registry.get(id)
    const wc = webContents.fromId(id)
    if (!entry) continue
    if (!wc || wc.isDestroyed() || !entry.win || entry.win.isDestroyed()) {
      registry.delete(id)
      continue
    }
    if (entry.kind === 'site') out.push(wc)
  }
  return out
}

// 隐藏到托盘后，窗口对象还活着但不可见；这里把还活着的站点窗口都捞出来，
// 顺带清掉已经销毁的登记，避免调用方拿到一个僵尸窗口。
function liveSiteWindows() {
  const out = []
  for (const id of Array.from(registry.keys())) {
    const entry = registry.get(id)
    if (!entry || entry.kind !== 'site') continue
    if (!entry.win || entry.win.isDestroyed()) {
      registry.delete(id)
      continue
    }
    out.push(entry.win)
  }
  return out
}

function windowsFor(account) {
  const list = []
  for (const entry of registry.values()) {
    if (entry.account === account && !entry.win.isDestroyed()) list.push(entry.win)
  }
  return list
}

function broadcastRules() {
  const state = rulesState()
  for (const wc of siteContents()) injector.pushRules(wc, state)
}

function registerIpc() {
  ipcMain.on('shield:intent', (event, msg) => handleIntent(event, msg))
}

function handleIntent(event, msg) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const payload = msg.payload || {}
  if (msg.type === 'activity') {
    // 页面里的 socket 帧说「有新东西」，立刻为该账号拉一次，不等轮询
    const entry = registry.get(event.sender.id)
    require('./notifications').pollAccountNow((entry && entry.account) || 'default')
    return
  }
  if (msg.type === 'block') {
    const isProject = payload.kind === 'project'
    const label = isProject ? '项目 ' + payload.id : '用户 ' + payload.id
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['屏蔽', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '加入屏蔽名单',
      message: '屏蔽' + label + '？',
      detail: (payload.title || '') + '\n' + (payload.url || '')
    })
    if (choice !== 0) return
    const res = isProject
      ? store.addProject({ id: payload.id, name: payload.title || '', url: payload.url || '' })
      : store.addUser({ id: payload.id, username: String(payload.username || ''), url: payload.url || '' })
    if (!res.ok) dialog.showMessageBoxSync(win, { type: 'warning', message: res.error })
    return
  }
  if (msg.type === 'reveal') {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['临时显示', '继续屏蔽'],
      defaultId: 1,
      cancelId: 1,
      title: '临时解除屏蔽',
      message: '临时显示' + (payload.kind === 'project' ? '该项目' : '该用户') + '？',
      detail: '临时解除只维持到本次运行，重启后恢复屏蔽。'
    })
    if (choice !== 0) return
    if (payload.kind === 'project') store.revealProject(payload.id)
    else store.revealUser(payload.id)
  }
}

module.exports = {
  registerIpc,
  createSiteWindow,
  siteContents,
  liveSiteWindows,
  windowsFor,
  broadcastRules,
  partitionFor,
  sessionFor,
  registry,
  setRules,
  setQuitting,
  setContextMenuHandler,
  get focusedAccount() { return focusedAccount },
  SITE
}
