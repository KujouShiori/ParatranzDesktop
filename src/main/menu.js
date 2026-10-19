'use strict'

const { Menu, shell, dialog } = require('electron')
const store = require('./store')
const windows = require('./windows')
const manage = require('./manage')
const pure = require('../shared/pure')

let revealMenuItem = null

function activeSiteWindow() {
  const win = require('electron').BrowserWindow.getFocusedWindow()
  if (win && windows.registry.has(win.webContents.id)) return win
  const list = windows.siteContents()
  if (!list.length) return null
  return list[0].getBrowserWindow()
}

function toggleRevealAll() {
  const next = !(store.snapshot().reveal && store.snapshot().reveal.all)
  store.setRevealAll(next)
  if (revealMenuItem) revealMenuItem.checked = next
}

function blockCurrentPage() {
  const win = activeSiteWindow()
  if (!win) return
  const info = pure.parseSiteUrl(win.webContents.getURL())
  const kind = info.projectId !== null ? 'project' : info.userId !== null ? 'user' : null
  if (!kind) {
    dialog.showMessageBoxSync(win, { type: 'info', message: '当前页面不是项目页或用户页，无法屏蔽。' })
    return
  }
  const id = kind === 'project' ? info.projectId : info.userId
  const title = win.getTitle()
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question',
    buttons: ['屏蔽', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '加入屏蔽名单',
    message: (kind === 'project' ? '屏蔽项目 ' : '屏蔽用户 ') + id + '？',
    detail: title + '\n' + win.webContents.getURL()
  })
  if (choice !== 0) return
  if (kind === 'project') store.addProject({ id: id, name: title, url: win.webContents.getURL() })
  else store.addUser({ id: id, url: win.webContents.getURL() })
}

function pageContextMenu(win, params) {
  const items = []
  const link = params.linkURL || ''
  const info = pure.parseSiteUrl(link)
  if (info.projectId !== null) {
    items.push({ label: '屏蔽项目 ' + info.projectId, click: () => store.addProject({ id: info.projectId, url: link }) })
  }
  if (info.userId !== null) {
    items.push({ label: '屏蔽用户 ' + info.userId, click: () => store.addUser({ id: info.userId, url: link }) })
  }
  if (params.selectionText) {
    const name = params.selectionText.trim().slice(0, 60)
    if (name && /^[\w\-.]{2,60}$/.test(name)) {
      items.push({ label: '屏蔽用户名「' + name + '」', click: () => store.addUser({ username: name }) })
    }
  }
  if (items.length) {
    items.push({ type: 'separator' })
  }
  items.push(
    { label: '打开屏蔽管理', click: () => manage.openManageWindow() },
    { label: '临时显示被屏蔽内容', type: 'checkbox', checked: !!store.snapshot().reveal.all, click: toggleRevealAll },
    { type: 'separator' },
    { label: '在浏览器中打开', enabled: !!params.pageURL, click: () => shell.openExternal(params.pageURL) }
  )
  Menu.buildFromTemplate(items).popup({ window: win })
}

function installAppMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建窗口（默认账号）', accelerator: 'CmdOrCtrl+Shift+W', click: () => windows.createSiteWindow({}) },
        { label: '打开屏蔽管理', accelerator: 'CmdOrCtrl+Shift+B', click: () => manage.openManageWindow() },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { require('electron').app.quit() } }
      ]
    },
    {
      label: '屏蔽',
      submenu: [
        { label: '屏蔽当前项目 / 当前用户', accelerator: 'CmdOrCtrl+Shift+X', click: blockCurrentPage },
        revealMenuItem = {
          label: '临时显示被屏蔽内容',
          type: 'checkbox',
          checked: !!store.snapshot().reveal.all,
          click: toggleRevealAll
        },
        { type: 'separator' },
        { label: '打开屏蔽管理', click: () => manage.openManageWindow() }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        {
          label: '开发者工具',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: (item, win) => {
            // 注入引擎占用了 CDP 会话，开 DevTools 前必须先让出，否则会打不开
            if (win) {
              require('./injector').detachForDevTools(win.webContents)
              win.webContents.toggleDevTools()
            }
          }
        },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭', role: 'close' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: 'Paratranz 网站', click: () => shell.openExternal('https://paratranz.cn/') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function syncMenuRevealState() {
  if (revealMenuItem) revealMenuItem.checked = !!(store.snapshot().reveal && store.snapshot().reveal.all)
}

module.exports = { installAppMenu, pageContextMenu, syncMenuRevealState, toggleRevealAll }
