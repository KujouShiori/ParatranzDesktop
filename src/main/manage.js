'use strict'

const fs = require('fs')
const path = require('path')
const { BrowserWindow, ipcMain, dialog } = require('electron')
const store = require('./store')
const windows = require('./windows')

const PRELOAD = path.join(__dirname, '..', 'preload', 'manage.js')
let manageWin = null

function openManageWindow() {
  if (manageWin && !manageWin.isDestroyed()) {
    manageWin.show()
    manageWin.focus()
    return manageWin
  }
  manageWin = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 560,
    minHeight: 420,
    title: '屏蔽管理',
    backgroundColor: '#1b1b1b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  manageWin.loadFile(path.join(__dirname, '..', 'ui', 'manage.html'))
  manageWin.on('closed', () => { manageWin = null })
  return manageWin
}

function sendAll(channel, payload) {
  if (manageWin && !manageWin.isDestroyed()) manageWin.webContents.send(channel, payload)
}

function registerManageIpc() {
  store.onChange((snap) => {
    windows.setRules(snap)
    windows.broadcastRules()
    sendAll('manage:changed', snap)
  })

  ipcMain.handle('manage:get', () => store.snapshot())

  ipcMain.handle('manage:add-project', (e, entry) => store.addProject(entry))
  ipcMain.handle('manage:remove-project', (e, id) => store.removeProject(id))
  ipcMain.handle('manage:add-user', (e, entry) => store.addUser(entry))
  ipcMain.handle('manage:remove-user', (e, key) => store.removeUser(key))

  ipcMain.handle('manage:reveal-project', (e, id) => { store.revealProject(id); return store.snapshot() })
  ipcMain.handle('manage:reveal-user', (e, key) => { store.revealUser(key); return store.snapshot() })
  ipcMain.handle('manage:reveal-all', (e, on) => { store.setRevealAll(on); return store.snapshot() })
  ipcMain.handle('manage:settings', (e, patch) => { store.updateSettings(patch); return store.snapshot() })

  ipcMain.handle('manage:open-site', (e, opts) => {
    windows.createSiteWindow(opts || {})
    return { ok: true }
  })

  ipcMain.handle('manage:account-add', (e, name) => {
    const id = 'acct-' + Date.now().toString(36)
    const res = store.upsertAccount({ id: id, name: name || id })
    return res.ok ? store.snapshot() : res
  })

  ipcMain.handle('manage:account-rename', (e, msg) => {
    store.upsertAccount({ id: msg.id, name: msg.name })
    return store.snapshot()
  })

  ipcMain.handle('manage:account-remove', (e, id) => {
    for (const win of windows.windowsFor(id)) win.close()
    store.removeAccount(id)
    return store.snapshot()
  })

  ipcMain.handle('plugins:list', () => require('./plugins').list())
  ipcMain.handle('plugins:toggle', (e, msg) => {
    const res = require('./plugins').toggle(msg.file, msg.enabled)
    require('./injector').refreshPluginsAll()
    return res
  })
  ipcMain.handle('plugins:open-folder', () => require('./plugins').openFolder())

  ipcMain.handle('login:token', (e, msg) => require('./login').loginWithToken((msg && msg.account) || 'default', msg && msg.token))
  ipcMain.handle('login:whoami', (e, account) => require('./login').whoami(account || 'default'))
  ipcMain.handle('login:open-token-page', () => require('./login').openTokenPage())

  ipcMain.handle('manage:export', async () => {
    const snap = store.snapshot()
    const body = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), blocklist: snap.blocklist }, null, 2)
    const res = await dialog.showSaveDialog({
      title: '导出屏蔽名单',
      defaultPath: 'paratranz-blocklist.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled) return { ok: false, error: '已取消' }
    fs.writeFileSync(res.filePath, body, 'utf8')
    return { ok: true, path: res.filePath }
  })

  ipcMain.handle('manage:import', async () => {
    const res = await dialog.showOpenDialog({
      title: '导入屏蔽名单',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: '已取消' }
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'))
    } catch (e) {
      return { ok: false, error: '文件不是合法 JSON' }
    }
    const list = parsed.blocklist || parsed
    if (!list || (!Array.isArray(list.projects) && !Array.isArray(list.users))) {
      return { ok: false, error: '文件里没有 blocklist 结构' }
    }
    let added = 0
    for (const p of list.projects || []) if (store.addProject(p).ok) added++
    for (const u of list.users || []) if (store.addUser(u).ok) added++
    return { ok: true, added: added }
  })
}

module.exports = { openManageWindow, registerManageIpc }
