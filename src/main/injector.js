'use strict'

const loader = require('../inject/loader')

// 注入时机是唯一硬约束：引擎必须赶在站点自己的脚本之前接管 fetch / XMLHttpRequest。
// Electron 44 没有主世界 preload，所以首选 CDP 的 Page.addScriptToEvaluateOnNewDocument；
// CDP 拿不到、或者注册赶不上首个文档时，dom-ready 兜底再打一次（代价是首屏可能闪一下）。
const SESSIONS = new WeakMap()
let cdpBackoffUntil = 0

function log(...args) {
  console.log('[注入]', ...args)
}

function randomToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

function bootstrapCode(sess) {
  const config = { token: sess.token, handleName: sess.handle, mode: 'full', rules: sess.state }
  const engineCall = '(' + loader.functionSource() + ')(' + JSON.stringify(config) + ');'
  // 插件排在屏蔽引擎之后：先接管 fetch / XMLHttpRequest，脚本才有机会去改写上层的显示，
  // 而不是绕过屏蔽去自己发请求。
  let plugins = ''
  try {
    plugins = require('./plugins').injectedSource()
  } catch (e) {
    console.log('[注入] 插件源码构建失败，本次只加载屏蔽引擎：', String(e && e.message ? e.message : e))
  }
  // 包一层 try/catch：executeJavaScript 只会报「脚本执行失败」，真实异常得自己捞回主进程
  return 'window.__ptBootError=null;try{' + engineCall + (plugins ? '\n' + plugins : '') + '}catch(e){window.__ptBootError=String((e&&e.stack)||e)}'
}

async function readBootError(wc) {
  try {
    return await wc.executeJavaScript('window.__ptBootError || null')
  } catch (e) {
    return '读取失败: ' + String(e && e.message ? e.message : e)
  }
}

function updateCode(sess) {
  return 'window[' + JSON.stringify(sess.handle) + '] && window[' + JSON.stringify(sess.handle) + '](' +
    JSON.stringify(sess.state) + ', ' + JSON.stringify(sess.token) + ');'
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('CDP 超时: ' + label)), ms))
  ])
}

async function hasEngine(wc) {
  try {
    return !!(await wc.executeJavaScript('!!(window.__ptShieldInfo && window.__ptShieldInfo())'))
  } catch (e) {
    return false
  }
}

function watchDomReady(wc, sess) {
  if (sess.watchingDomReady) return
  sess.watchingDomReady = true
  wc.on('dom-ready', async () => {
    if (wc.isDestroyed()) return
    if (await hasEngine(wc)) return
    log('dom-ready 兜底注入', sess.mode)
    wc.executeJavaScript(bootstrapCode(sess))
      .then(async () => {
        const err = await readBootError(wc)
        if (err) log('引擎在页面里抛错：', err)
      })
      .catch((e) => log('兜底注入失败', String(e && e.message ? e.message : e)))
    wc.executeJavaScript(updateCode(sess)).catch(() => {})
  })
}

async function cdpInject(wc, sess) {
  await withTimeout(wc.debugger.sendCommand('Page.enable'), 2000, 'Page.enable')
  const res = await withTimeout(
    wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: bootstrapCode(sess) }),
    2000,
    'addScriptToEvaluateOnNewDocument'
  )
  sess.scriptId = res && res.identifier
  sess.mode = 'cdp'
  return 'cdp'
}

// 无论如何都会 resolve，调用方可以直接在 then 里开始导航
function install(wc, state) {
  if (!wc || wc.isDestroyed()) return Promise.resolve('none')
  let sess = SESSIONS.get(wc)
  if (!sess) {
    sess = { mode: 'none', token: randomToken(), handle: '__ptApply_' + randomToken(), state: state, watchingDomReady: false }
    SESSIONS.set(wc, sess)
  }
  sess.state = state
  watchDomReady(wc, sess)
  if (sess.mode !== 'none') return Promise.resolve(sess.mode)

  const skipCdp = Date.now() < cdpBackoffUntil || !wc.debugger
  const devToolsBusy = typeof wc.isDevToolsOpened === 'function' && wc.isDevToolsOpened()
  if (skipCdp || devToolsBusy) {
    sess.mode = 'fallback'
    return Promise.resolve('fallback')
  }
  try {
    wc.debugger.attach('1.3')
  } catch (e) {
    log('CDP 会话打不开，退回 dom-ready：', String(e && e.message ? e.message : e))
    cdpBackoffUntil = Date.now() + 30 * 1000
    sess.mode = 'fallback'
    return Promise.resolve('fallback')
  }
  wc.debugger.on('detach', (event, reason) => {
    sess.mode = 'none'
    if (reason === 'target closed' || wc.isDestroyed()) return
    log('CDP 会话断开（' + reason + '），此后靠 dom-ready 兜底')
  })
  return cdpInject(wc, sess).catch((e) => {
    log('CDP 注册失败：', String(e && e.message ? e.message : e))
    cdpBackoffUntil = Date.now() + 30 * 1000
    try {
      wc.debugger.detach()
    } catch (e2) {}
    sess.mode = 'fallback'
    return 'fallback'
  })
}

// 插件增删或开关之后，重新注册 document-start 脚本；已经在看的页面要重载才生效，
// 这里不替用户刷新，免得把他正在编辑的译文草稿打断。
function refreshPlugins(wc) {
  const sess = SESSIONS.get(wc)
  if (!sess || wc.isDestroyed()) return
  if (sess.mode === 'cdp' && sess.scriptId) {
    wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: sess.scriptId })
      .then(() => cdpInject(wc, sess))
      .catch((e) => console.log('[注入] 插件刷新失败', String(e && e.message ? e.message : e)))
  }
}

function refreshPluginsAll() {
  for (const wc of require('electron').webContents.getAllWebContents()) {
    if (!wc.isDestroyed() && SESSIONS.get(wc)) refreshPlugins(wc)
  }
}

function pushRules(wc, state) {
  const sess = SESSIONS.get(wc)
  if (!sess || wc.isDestroyed()) return
  sess.state = state
  wc.executeJavaScript(updateCode(sess)).catch((e) => log('下发规则失败', String(e && e.message ? e.message : e)))
}

// 首次导航前 CDP 目标还没建好会超时；等第一次加载完成后再试一次，
// 成功了以后的导航就都是真正的 document-start 注入，不再有首屏闪一下的问题。
function upgradeCdp(wc, state) {
  const sess = SESSIONS.get(wc)
  if (!sess || wc.isDestroyed() || sess.mode !== 'fallback') return Promise.resolve(sess ? sess.mode : 'none')
  if (Date.now() < cdpBackoffUntil || !wc.debugger || wc.debugger.isAttached()) return Promise.resolve(sess.mode)
  if (typeof wc.isDevToolsOpened === 'function' && wc.isDevToolsOpened()) return Promise.resolve(sess.mode)
  try {
    wc.debugger.attach('1.3')
  } catch (e) {
    cdpBackoffUntil = Date.now() + 30 * 1000
    return Promise.resolve('fallback')
  }
  sess.state = state
  wc.debugger.on('detach', (event, reason) => {
    sess.mode = 'none'
    if (reason === 'target closed' || wc.isDestroyed()) return
    log('CDP 会话断开（' + reason + '），此后靠 dom-ready 兜底')
  })
  return cdpInject(wc, sess)
    .then((m) => {
      log('已升级为 document-start 注入')
      return m
    })
    .catch((e) => {
      log('升级 document-start 失败：', String(e && e.message ? e.message : e))
      cdpBackoffUntil = Date.now() + 30 * 1000
      try {
        wc.debugger.detach()
      } catch (e2) {}
      return 'fallback'
    })
}

function mode(wc) {
  const sess = SESSIONS.get(wc)
  return sess ? sess.mode : 'none'
}

async function describe(wc) {
  if (wc.isDestroyed()) return { mode: 'destroyed' }
  const sess = SESSIONS.get(wc)
  let info = null
  try {
    info = await wc.executeJavaScript('window.__ptShieldInfo ? window.__ptShieldInfo() : null')
  } catch (e) {
    info = { probeError: String(e && e.message ? e.message : e) }
  }
  return { mode: sess ? sess.mode : 'none', handle: sess ? sess.handle : null, info: info }
}

function detachForDevTools(wc) {
  const sess = SESSIONS.get(wc)
  if (wc.debugger && wc.debugger.isAttached()) {
    try {
      wc.debugger.detach()
    } catch (e) {}
  }
  if (sess) sess.mode = 'none'
}

module.exports = { install, upgradeCdp, pushRules, refreshPlugins, refreshPluginsAll, mode, describe, detachForDevTools }
