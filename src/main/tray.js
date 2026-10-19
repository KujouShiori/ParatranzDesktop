'use strict'

const { Tray, Menu, nativeImage, globalShortcut, BrowserWindow } = require('electron')
const store = require('./store')
const windows = require('./windows')
const manage = require('./manage')
const menu = require('./menu')

let tray = null

function trayIcon() {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      const i = (y * size + x) * 4
      const on = d < 6.6 || (d > 3.2 && d < 4.6)
      const v = on ? 232 : 0
      // 灰阶图案，红蓝通道同值，避免 BGRA / RGBA 字节序差异把图标画歪
      buf[i] = v
      buf[i + 1] = v
      buf[i + 2] = v
      buf[i + 3] = on ? 255 : 0
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function focusMain() {
  const list = windows.siteContents()
  if (!list.length) {
    windows.createSiteWindow({})
    return
  }
  const win = list[0].getBrowserWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function buildMenu() {
  const snap = store.snapshot()
  const template = [
    { label: '显示 Paratranz 窗口', click: focusMain },
    { label: '屏蔽管理…', click: () => manage.openManageWindow() },
    {
      label: '临时显示被屏蔽内容',
      type: 'checkbox',
      checked: !!(snap.reveal && snap.reveal.all),
      click: () => menu.toggleRevealAll()
    },
    { type: 'separator' }
  ]
  for (const a of snap.accounts) {
    template.push({ label: '打开账号「' + a.name + '」', click: () => windows.createSiteWindow({ account: a.id }) })
  }
  if (snap.accounts.length) template.push({ type: 'separator' })
  template.push({ label: '退出', click: () => require('electron').app.quit() })
  return Menu.buildFromTemplate(template)
}

function refresh() {
  if (tray) tray.setContextMenu(buildMenu())
  menu.syncMenuRevealState()
}

function installTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('Paratranz Desktop')
  tray.setContextMenu(buildMenu())
  tray.on('click', focusMain)
  tray.on('double-click', focusMain)
  store.onChange(refresh)
  return tray
}

function installShortcuts() {
  const map = {
    'CommandOrControl+Alt+P': focusMain,
    'CommandOrControl+Alt+B': () => manage.openManageWindow(),
    'CommandOrControl+Alt+R': () => menu.toggleRevealAll()
  }
  const failed = []
  for (const key of Object.keys(map)) {
    if (!globalShortcut.isRegistered(key)) globalShortcut.register(key, map[key])
    if (!globalShortcut.isRegistered(key)) failed.push(key)
  }
  return failed
}

function removeShortcuts() {
  globalShortcut.unregisterAll()
}

function destroyTray() {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

module.exports = { installTray, installShortcuts, removeShortcuts, destroyTray, refreshTray: refresh, focusMain }
