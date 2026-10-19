'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// 引擎由主进程注入到主世界，这里只做一件事：把页面上「屏蔽 / 临时显示」按钮的点击
// 转成 IPC 请求。请求内容不可信（页面脚本也能 postMessage），所以真正的名单变更
// 一定还要过主进程的原生确认框。
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.channel !== 'pt-shield-intent') return
  ipcRenderer.send('shield:intent', {
    type: e.data.type,
    payload: e.data.payload,
    href: location.href
  })
})

contextBridge.exposeInMainWorld('ptShieldPage', { version: 1 })
