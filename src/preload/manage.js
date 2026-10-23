'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const call = (channel, arg) => ipcRenderer.invoke(channel, arg)

contextBridge.exposeInMainWorld('ptManage', {
  get: () => call('manage:get'),
  addProject: (entry) => call('manage:add-project', entry),
  removeProject: (id) => call('manage:remove-project', id),
  addUser: (entry) => call('manage:add-user', entry),
  removeUser: (key) => call('manage:remove-user', key),
  revealProject: (id) => call('manage:reveal-project', id),
  revealUser: (key) => call('manage:reveal-user', key),
  currentTarget: () => call('manage:current-target'),
  blockCurrent: () => call('manage:block-current'),
  setRevealAll: (on) => call('manage:reveal-all', !!on),
  setSettings: (patch) => call('manage:settings', patch),
  openSite: (opts) => call('manage:open-site', opts),
  accountAdd: (name) => call('manage:account-add', name),
  accountRename: (msg) => call('manage:account-rename', msg),
  accountRemove: (id) => call('manage:account-remove', id),
  exportList: () => call('manage:export'),
  importList: () => call('manage:import'),
  loginWithToken: (msg) => call('login:token', msg),
  whoami: (account) => call('login:whoami', account),
  openTokenPage: () => call('login:open-token-page'),
  plugins: () => call('plugins:list'),
  togglePlugin: (msg) => call('plugins:toggle', msg),
  openPluginFolder: () => call('plugins:open-folder'),
  onChanged: (fn) => {
    ipcRenderer.on('manage:changed', (e, snap) => fn(snap))
  }
})
