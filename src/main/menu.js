'use strict'

const { Menu, shell, dialog } = require('electron')
const store = require('./store')
const windows = require('./windows')
const manage = require('./manage')
const pure = require('../shared/pure')

let revealMenuItem = null

function accountLabel(account) {
  if (!account || account === 'default') return '默认窗口'
  const a = (store.snapshot().accounts || []).find((x) => x.id === account)
  return a ? a.name : account
}

// 屏蔽管理窗口要按这个结果决定按钮上写什么；它只读，不改任何东西。
function currentPageTarget() {
  const win = windows.activeSiteWindow()
  if (!win) return null
  const hit = pure.targetOfUrl(win.webContents.getURL())
  if (!hit) return null
  const entry = windows.registry.get(win.webContents.id)
  return {
    kind: hit.kind,
    id: hit.id,
    title: win.getTitle(),
    url: win.webContents.getURL(),
    account: entry ? entry.account : 'default'
  }
}

// hostWin：对话框挂在哪个窗口上。从屏蔽管理里点就挂过去，
// 否则弹在用户没在看的那个窗口上，像是点错了地方。
function blockCurrentPage(hostWin) {
  const site = windows.activeSiteWindow()
  const target = currentPageTarget()
  if (!target) {
    dialog.showMessageBoxSync(hostWin || site || undefined, {
      type: 'info',
      message: site ? '站点窗口当前不在项目页或用户页上，没有可屏蔽的对象。' : '还没有打开的站点窗口。'
    })
    return null
  }
  const choice = dialog.showMessageBoxSync(hostWin || site, {
    type: 'question',
    buttons: ['屏蔽', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '加入屏蔽名单',
    message: (target.kind === 'project' ? '屏蔽项目 ' : '屏蔽用户 ') + target.id + '？',
    detail: target.title + '\n' + target.url
  })
  if (choice !== 0) return null
  const res = target.kind === 'project'
    ? store.addProject({ id: target.id, name: target.title, url: target.url })
    : store.addUser({ id: target.id, url: target.url })
  if (res && !res.ok) dialog.showMessageBoxSync(hostWin || site, { type: 'warning', message: res.error })
  return res
}

function toggleRevealAll() {
  const next = !(store.snapshot().reveal && store.snapshot().reveal.all)
  store.setRevealAll(next)
  if (revealMenuItem) revealMenuItem.checked = next
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
        { label: '屏蔽当前项目 / 当前用户', accelerator: 'CmdOrCtrl+Shift+X', click: (item, win) => blockCurrentPage(win) },
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

module.exports = { installAppMenu, pageContextMenu, syncMenuRevealState, toggleRevealAll, currentPageTarget, blockCurrentPage }
