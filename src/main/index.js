'use strict'

const { app, BrowserWindow } = require('electron')
const store = require('./store')
const windows = require('./windows')
const manage = require('./manage')
const menu = require('./menu')
const tray = require('./tray')
const notifications = require('./notifications')

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => tray.focusMain())

  app.whenReady().then(() => {
    app.setAppUserModelId('cn.paratranz.desktop')
    store.load()
    windows.setRules(store.snapshot())
    windows.setContextMenuHandler(menu.pageContextMenu)
    windows.registerIpc()
    manage.registerManageIpc()
    menu.installAppMenu()
    tray.installTray()
    const failedShortcuts = tray.installShortcuts()
    if (failedShortcuts.length) console.warn('全局快捷键被占用:', failedShortcuts.join(', '))
    notifications.start()

    if (process.argv.includes('--selftest')) {
      require('./selftest').run().then((report) => {
        windows.setQuitting(true)
        app.exit(report.pass ? 0 : 1)
      }).catch((e) => {
        console.error('selftest crashed', e)
        app.exit(2)
      })
      return
    }

    windows.createSiteWindow({})

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) windows.createSiteWindow({})
    })
  })

  app.on('before-quit', () => {
    windows.setQuitting(true)
    tray.removeShortcuts()
    tray.destroyTray()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  process.on('uncaughtException', (e) => {
    console.error('[未捕获异常]', e)
  })
}
