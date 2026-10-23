'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const windows = require('./windows')
const injector = require('./injector')
const store = require('./store')

const OUT = () => path.join(app.getPath('userData'), 'selftest')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 截图只是给人看证据的，抓不到不该把整条自检判红
async function shoot(wc, name) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const img = await wc.capturePage()
      const file = path.join(OUT(), name + '.png')
      fs.writeFileSync(file, img.toPNG())
      return { file: file }
    } catch (e) {
      await sleep(1200)
      if (attempt === 3) return { captureError: String(e && e.message ? e.message : e) }
    }
  }
}

function waitFinishLoad(wc) {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve() }
    const fail = (e, url, code, detail) => { cleanup(); reject(new Error('load failed ' + url + ' ' + code + ' ' + detail)) }
    const cleanup = () => {
      wc.removeListener('did-finish-load', ok)
      wc.removeListener('did-fail-load', fail)
    }
    wc.on('did-finish-load', ok)
    wc.on('did-fail-load', fail)
  })
}

async function probe(wc, code) {
  return wc.executeJavaScript('(async () => {' + code + '})()')
}

// Electron 对「站点没有 CSP」的警告不是页面错误，别把它算成失败
function isElectronWarning(message) {
  return typeof message === 'string' && message.indexOf('Electron Security Warning') >= 0
}

function recordRequests(ses) {
  const log = []
  ses.webRequest.onBeforeRequest({ urls: ['*://paratranz.cn/api/*'] }, (details, callback) => {
    log.push(details.url)
    callback({})
  })
  return {
    log: log,
    reset() {
      log.length = 0
    },
    matching(sub) {
      return log.filter((u) => u.indexOf(sub) >= 0)
    }
  }
}

// 登录后才有真实样本：这里只把「字段名 + 值类型」记进报告，私信正文一律不落盘。
function shapeOf(value, depth) {
  if (Array.isArray(value)) return value.length ? { array: [shapeOf(value[0], depth + 1)] } : { array: [] }
  if (value === null) return 'null'
  if (typeof value !== 'object') return typeof value
  if (depth > 2) return 'object'
  const out = {}
  for (const k of Object.keys(value)) out[k] = shapeOf(value[k], depth + 1)
  return out
}

async function probeRealFeeds(ses) {
  const out = {}
  const me = await ses.fetch('https://paratranz.cn/api/account', { headers: { accept: 'application/json' } })
  const meText = (await me.text()).trim()
  if (!meText) {
    out.loggedIn = false
    return out
  }
  const account = JSON.parse(meText)
  out.loggedIn = true
  out.username = account.username
  for (const feed of require('./notifications').FEEDS) {
    try {
      const res = await ses.fetch('https://paratranz.cn' + feed.list, { headers: { accept: 'application/json' } })
      const json = res.ok ? await res.json() : null
      const items = require('../shared/notify').itemsOf(json)
      out[feed.id] = { status: res.status, count: items.length, first: items.length ? shapeOf(items[0], 0) : null }
    } catch (e) {
      out[feed.id] = { error: String(e && e.message ? e.message : e) }
    }
  }
  return out
}

async function run() {
  const report = { startedAt: new Date().toISOString(), electron: process.versions.electron, chrome: process.versions.chrome, steps: [] }
  fs.mkdirSync(OUT(), { recursive: true })
  const dump = () => fs.writeFileSync(path.join(OUT(), 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  const watchdog = setTimeout(() => {
    report.timedOut = true
    report.pass = false
    dump()
    console.log('SELFTEST TIMEOUT，已完成步骤: ' + report.steps.map((s) => s.name).join(' | '))
    app.exit(3)
  }, 170000)

  const step = async (name, fn) => {
    try {
      const detail = await fn()
      report.steps.push({ name: name, ok: true, detail: detail === undefined ? null : detail })
      console.log('PASS ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
    } catch (e) {
      report.steps.push({ name: name, ok: false, error: String(e && e.message ? e.message : e) })
      console.log('FAIL ' + name + '  ' + (e && e.stack ? e.stack : e))
    }
  }

  const win = windows.createSiteWindow({})
  const wc = win.webContents
  const ses = windows.sessionFor('default')
  const net = recordRequests(ses)
  const consoleErrors = []
  wc.on('console-message', (event, level, message, line, sourceId) => {
    if (isElectronWarning(message)) return
    if (level >= 3) consoleErrors.push(message + ' @' + (sourceId || '') + ':' + line)
  })

  await step('站点页面加载完成', async () => {
    await waitFinishLoad(wc)
    await sleep(1500)
    return { title: await wc.getTitle(), url: wc.getURL(), injector: await injector.describe(wc) }
  })

  await step('引擎已注入且改写了 fetch', async () => {
    const info = await probe(wc, `
      const i = window.__ptShieldInfo && window.__ptShieldInfo();
      if (!i) throw new Error('引擎没装上（找不到诊断出口）。renderer 错误: ' + (window.__ptLastErr || 'none'));
      if (!i.patchedFetch) throw new Error('fetch 未被接管');
      return i;
    `)
    if (consoleErrors.length) info.rendererErrors = consoleErrors.slice(0, 5)
    return info
  })

  let victim = null
  let victimInStore = false
  await step('从线上列表取一个屏蔽靶子', async () => {
    const res = await ses.fetch('https://paratranz.cn/api/projects?page=1&pageSize=50', { headers: { accept: 'application/json' } })
    const json = await res.json()
    if (!json.results || !json.results.length) throw new Error('列表为空')
    victim = json.results[0]
    // 走真实链路：写进名单 → store 广播 → 主进程规则 + 网络兜底 + 引擎，全都会拿到它
    store.addProject({ id: victim.id, name: victim.name, url: 'https://paratranz.cn/projects/' + victim.id })
    victimInStore = true
    return { id: victim.id, name: victim.name }
  })

  await step('项目列表里屏蔽项不再被渲染出来', async () => {
    wc.loadURL('https://paratranz.cn/projects')
    await waitFinishLoad(wc)
    await sleep(3000)
    const victimId = String(victim ? victim.id : -1)
    return probe(wc, `
      const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).display !== 'none';
      const cards = [...document.querySelectorAll('.project')];
      const visCards = cards.filter(visible);
      const blockedVisible = visCards.filter(c => {
        const a = c.querySelector('a[href^="/projects/"]');
        return a && a.getAttribute('href').split('/')[2] === ${JSON.stringify(victimId)};
      }).length;
      return {
        cardsInDom: cards.length,
        cardsVisible: visCards.length,
        hiddenByEngine: document.querySelectorAll('[data-pt-shielded]').length,
        blockedButVisible: blockedVisible,
        engine: window.__ptShieldInfo ? window.__ptShieldInfo() : null
      };
    `).then((r) => {
      if (r.cardsVisible === 0) throw new Error('列表根本没有可见卡片，无法判断屏蔽效果：' + JSON.stringify(r))
      if (r.blockedButVisible > 0) throw new Error('被屏蔽项目仍然显示在列表里')
      if (!r.hiddenByEngine) throw new Error('屏蔽生效了，但不是引擎隐藏的（可能是网络兜底）：' + JSON.stringify(r))
      return r
    })
  })

  await step('被屏蔽项目的接口请求根本不发出去', async () => {
    net.reset()
    const out = await probe(wc, `
      const r = await fetch('/api/projects/${victim ? victim.id : 0}');
      const t = await r.text();
      return { status: r.status, body: t };
    `)
    const leaked = net.matching('/api/projects/' + (victim ? victim.id : 0))
    if (leaked.length) throw new Error('请求漏到了网络层: ' + leaked.join(', '))
    if (out.status !== 404) throw new Error('期望 404，实际 ' + out.status)
    if (JSON.parse(out.body).message.indexOf('does not exist') < 0) throw new Error('错误体不符合站点契约: ' + out.body)
    return out
  })

  await step('直接访问被屏蔽项目 URL 会被墙住', async () => {
    wc.loadURL('https://paratranz.cn/projects/' + (victim ? victim.id : 0) + '/terms')
    await waitFinishLoad(wc)
    await sleep(2500)
    const r = await probe(wc, `
      const wall = document.querySelector('.pt-shield-wall');
      return { wall: !!wall, text: wall ? wall.textContent : null, bodyAttr: document.body.getAttribute('data-page') };
    `)
    if (!r.wall) throw new Error('没有出现屏蔽墙')
    return r
  })

  await step('截图：屏蔽墙', () => shoot(wc, 'wall'))

  await step('临时解除后页面自己把内容取回来', async () => {
    // 墙是本地判定，这个页面的数据当初就被硬屏蔽挡掉了。只下发新规则的话，
    // 用户看到的是「墙消失了但内容还是空的」，等于解不开屏蔽——所以必须重载并检查渲染结果。
    let reloads = 0
    const onStart = () => { reloads++ }
    wc.on('did-start-navigation', onStart)
    net.reset()
    store.revealProject(victim.id)
    const deadline = Date.now() + 20000
    while (reloads === 0 && Date.now() < deadline) await sleep(100)
    while (wc.isLoading() && Date.now() < deadline) await sleep(100)
    wc.removeListener('did-start-navigation', onStart)
    if (reloads === 0) throw new Error('解除屏蔽后窗口没有重新加载，页面数据仍然取不回来')
    await sleep(3000)
    const r = await probe(wc, `
      const wall = document.querySelector('.pt-shield-wall');
      return {
        wall: !!wall,
        nameShown: (document.body.innerText || '').indexOf(${JSON.stringify(String(victim.name || ''))}) >= 0,
        visibleRows: [...document.querySelectorAll('table tbody tr, .project, .string')].filter((n) => n.getClientRects().length > 0).length,
        revealed: window.__ptShieldInfo ? window.__ptShieldInfo().stats : null
      };
    `)
    if (r.wall) throw new Error('解除后屏蔽墙仍在：' + JSON.stringify(r))
    if (!r.nameShown) throw new Error('解除后页面上看不到项目名，内容没被重新取回来：' + JSON.stringify(r))
    const own = net.matching('/api/projects/' + victim.id)
    if (!own.length) throw new Error('页面自己没有重新请求该项目接口：' + JSON.stringify(r))
    return { reloads: reloads, nameShown: r.nameShown, visibleRows: r.visibleRows, requests: own.length }
  })

  await step('翻译工作台页面能正常渲染', async () => {
    wc.loadURL('https://paratranz.cn/projects/' + (victim ? victim.id : 10709) + '/terms')
    await waitFinishLoad(wc)
    await sleep(3500)
    const r = await probe(wc, `
      return {
        dataPage: document.body.getAttribute('data-page'),
        bodyChildren: document.body.children.length,
        navLinks: document.querySelectorAll('.nav-link').length,
        links: document.querySelectorAll('a[href^="/projects/"]').length,
        rows: document.querySelectorAll('table tbody tr, .terms-tab, .tab.terms-tab').length,
        inputs: document.querySelectorAll('input, textarea').length,
        bootError: window.__ptBootError || null,
        title: document.title
      };
    `)
    if (r.bodyChildren < 1) throw new Error('页面主体是空的：' + JSON.stringify(r))
    if (r.navLinks < 3) throw new Error('导航没有渲染出来，页面可能是空白或报错：' + JSON.stringify(r))
    if (!r.dataPage) throw new Error('路由未接管页面（body 上没有 data-page）')
    if (r.bootError) throw new Error('引擎在页面里抛错：' + r.bootError)
    return r
  })

  await step('截图：术语表页面', () => shoot(wc, 'terms'))

  await step('清理：靶子从名单里移除', async () => {
    if (victimInStore) store.removeProject(victim.id)
    await sleep(600)
    const snap = store.snapshot()
    if (snap.blocklist.projects.some((p) => p.id === victim.id)) throw new Error('靶子没有从名单里清掉')
    return { projects: snap.blocklist.projects.length, users: snap.blocklist.users.length }
  })

  await step('屏蔽管理窗口能渲染并操作名单', async () => {
    const manage = require('./manage')
    const mw = manage.openManageWindow()
    const errs = []
    mw.webContents.on('console-message', (event, level, message) => {
      if (isElectronWarning(message)) return
      if (level >= 3) errs.push(message.slice(0, 200))
    })
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 6000)
      mw.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        setTimeout(resolve, 800)
      })
    })
    const safe = async (code) => {
      try {
        return await mw.webContents.executeJavaScript(code)
      } catch (e) {
        return { probeError: String(e && e.message ? e.message : e) }
      }
    }
    try {
      const diag = await safe('JSON.stringify({ title: document.title, url: location.href, hasTable: !!document.getElementById("projectTable"), scripts: document.scripts.length, bodyLen: (document.body||{innerHTML:""}).innerHTML.length })')
      if (typeof diag !== 'string') throw new Error('管理窗口探针失败：' + JSON.stringify({ diag, errs }))
      store.addProject({ id: 999999, name: '自检用假项目' })
      await sleep(900)
      const r = await safe(`
        (() => {
          const rows = [...document.querySelectorAll('#projectTable tbody tr')].map(tr => tr.textContent);
          return {
            diag: ${JSON.stringify(diag)},
            hasRevealSwitch: !!document.getElementById('revealAll'),
            hasDumpSwitch: !!document.getElementById('dumpShapes'),
            hasAutoClearSwitch: !!document.getElementById('autoClearMail'),
            autoClearOffByDefault: !!document.getElementById('autoClearMail') && document.getElementById('autoClearMail').checked === false,
            projectRows: rows,
            userRows: document.querySelectorAll('#userTable tbody tr').length,
            accounts: document.querySelectorAll('#accountList li').length
          };
        })()
      `)
      if (r.probeError) throw new Error('管理窗口脚本执行失败：' + r.probeError + ' | 页面报错: ' + errs.slice(0, 3).join(' | '))
      const fake = r.projectRows.find((line) => line.indexOf('999999') >= 0)
      if (!r.hasRevealSwitch || !r.hasDumpSwitch) throw new Error('设置开关没渲染出来：' + JSON.stringify(r))
      if (!r.hasAutoClearSwitch) throw new Error('「自动标已读」开关没渲染出来：' + JSON.stringify(r))
      if (!r.autoClearOffByDefault) throw new Error('「自动标已读」应当默认关闭')
      if (!fake) throw new Error('新加入的项目没有出现在管理窗口里：' + JSON.stringify(r))
      if (!/临时显示/.test(fake) || !/删除/.test(fake)) throw new Error('行内操作按钮缺失：' + fake)
      if (errs.length) throw new Error('管理窗口有报错：' + errs.slice(0, 3).join(' | '))
      return { rows: r.projectRows.length, userRows: r.userRows, accounts: r.accounts }
    } finally {
      store.removeProject(999999)
      mw.close()
    }
  })

  await step('多账号窗口各自独立且共享名单', async () => {
    store.upsertAccount({ id: 'acct-selftest', name: '自检账号二' })
    store.addProject({ id: 999998, name: '自检用假项目' })
    const second = windows.createSiteWindow({ account: 'acct-selftest' })
    await waitFinishLoad(second.webContents)
    await sleep(2500)
    const first = win
    const sesA = first.webContents.session
    const sesB = second.webContents.session
    const inBoth = await Promise.all([
      first.webContents.executeJavaScript('!!(window.__ptShieldInfo && window.__ptShieldInfo().projects.includes(999998))'),
      second.webContents.executeJavaScript('!!(window.__ptShieldInfo && window.__ptShieldInfo().projects.includes(999998))')
    ])
    second.close()
    store.removeProject(999998)
    store.removeAccount('acct-selftest')
    if (sesA === sesB) throw new Error('两个账号共用了同一个会话，登录状态会互相串')
    if (sesB !== windows.sessionFor('acct-selftest')) throw new Error('第二个窗口没有落在账号自己的会话上')
    if (sesA !== windows.sessionFor('default')) throw new Error('主窗口没有落在默认会话上')
    if (!inBoth[0] || !inBoth[1]) throw new Error('名单没有同时下发到两个窗口：' + JSON.stringify(inBoth))
    return { separateSessions: true, rulesInBothWindows: inBoth }
  })

  await step('插件脚本在真实页面里执行且按 @match 过滤', async () => {
    const plugins = require('./plugins')
    const fs = require('fs')
    const path = require('path')
    const hit = path.join(plugins.dir(), 'pt-selftest-hit.user.js')
    const miss = path.join(plugins.dir(), 'pt-selftest-miss.user.js')
    fs.writeFileSync(hit, [
      '// ==UserScript==',
      '// @name        自检-应命中',
      '// @match       https://paratranz.cn/*',
      '// ==/UserScript==',
      'window.__ptSelfPlugin = "ran";'
    ].join('\n'))
    fs.writeFileSync(miss, [
      '// ==UserScript==',
      '// @name        自检-不该命中',
      '// @match       https://example.invalid/*',
      '// ==/UserScript==',
      'window.__ptSelfPluginMiss = "ran";'
    ].join('\n'))
    const second = windows.createSiteWindow({ url: 'https://paratranz.cn/projects' })
    await waitFinishLoad(second.webContents)
    await sleep(2500)
    const r = await second.webContents.executeJavaScript('JSON.stringify({hit: String(window.__ptSelfPlugin || "absent"), miss: String(window.__ptSelfPluginMiss || "absent"), boot: window.__ptBootError || null})').then((s) => JSON.parse(s))
    second.close()
    fs.unlinkSync(hit)
    fs.unlinkSync(miss)
    injector.refreshPluginsAll()
    if (r.boot) throw new Error('注入抛错：' + r.boot)
    if (r.hit !== 'ran') throw new Error('匹配的插件没有执行：' + JSON.stringify(r))
    if (r.miss !== 'absent') throw new Error('不匹配的插件也执行了：' + JSON.stringify(r))
    return r
  })

  await step('隐藏到托盘后能唤回窗口', async () => {
    const tray = require('./tray')
    win.hide()
    await sleep(400)
    if (win.isVisible()) throw new Error('hide() 之后窗口仍然可见，测试前提不成立')
    tray.focusMain()
    await sleep(900)
    const state = { visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized() }
    if (!state.visible) throw new Error('唤回失败，窗口还藏着：' + JSON.stringify(state))
    return state
  })

  await step('接管 WebSocket 后站点连接仍然正常', async () => {
    const r = await probe(wc, `
      return new Promise((resolve) => {
        const out = { patched: false, opened: false, gotPacket: false, error: null, sample: null };
        try {
          out.patched = String(window.WebSocket).indexOf('WatchedWebSocket') >= 0 ||
            !!window.WebSocket.prototype.__ptShieldWatched;
          const s = new WebSocket('wss://paratranz.cn/socket.io/?EIO=4&transport=websocket');
          const done = () => resolve(JSON.stringify(out));
          setTimeout(done, 6000);
          s.onopen = () => { out.opened = true; };
          s.onmessage = (ev) => {
            if (!out.gotPacket) { out.gotPacket = true; out.sample = String(ev.data).slice(0, 24); done(); }
          };
          s.onerror = () => { out.error = 'error'; done(); };
          s.onclose = () => { if (!out.gotPacket) { out.error = out.error || 'closed'; done(); } };
        } catch (e) {
          out.error = String(e && e.message ? e.message : e);
          resolve(JSON.stringify(out));
        }
      })
    `).then((s) => JSON.parse(s))
    if (!r.patched) throw new Error('WebSocket 没有被接管，实时提醒不会生效：' + JSON.stringify(r))
    if (r.error) throw new Error('接管后连接失败：' + JSON.stringify(r))
    if (!r.gotPacket) throw new Error('连上了但没收到引擎握手包，旁听可能挡住了数据：' + JSON.stringify(r))
    return r
  })

  await step('提醒轮询能跑通（未登录只能验证到公开源）', async () => {
    const notifications = require('./notifications')
    notifications.resetForTests()
    net.reset()
    await notifications.pollAll()
    await sleep(1200)
    const primed = notifications.debugState()
    const keys = Object.keys(primed)
    if (keys.length < 3) throw new Error('三个消息源没有都尝试过：' + JSON.stringify(primed))
    if (!primed['default/broadcasts'] || !primed['default/broadcasts'].primed) {
      throw new Error('公开公告源拉到了却没被记账：' + JSON.stringify(primed))
    }
    return { primed: primed, requestsSeen: net.matching('/api/').length }
  })

  await step('真实私信接口字段与提醒判定', async () => {
    const probe = await probeRealFeeds(ses)
    if (!probe.loggedIn) {
      console.log('  (未登录，跳过：登录后再跑这一步可以拿到真实字段)')
      return { skipped: '未登录' }
    }
    const mails = probe.mails || {}
    if (mails.status === 401) throw new Error('账号已登录但私信接口仍 401')
    report.realShapes = probe
    return {
      account: probe.username,
      mails: { status: mails.status, count: mails.count, keys: mails.first && Object.keys(mails.first) },
      messages: probe.messages && { status: probe.messages.status, count: probe.messages.count, keys: probe.messages.first && Object.keys(probe.messages.first) },
      broadcasts: probe.broadcasts && { status: probe.broadcasts.status, count: probe.broadcasts.count }
    }
  })

  await step('托盘图标真的画出来了', () => {
    const info = require('./tray').iconInfo()
    if (info.empty) throw new Error('托盘图标是空的：' + JSON.stringify(info))
    if (!info.fromFile) throw new Error('没找到 ico，退回位图，可能显示成空白：' + JSON.stringify(info))
    return info
  })

  await step('未读计数快探能跑', async () => {
    const notifications = require('./notifications')
    await notifications.fastProbe()
    return { probed: true }
  })

  await step('退出前名单不含自检残留', () => {
    const snap = store.snapshot()
    const residue = snap.blocklist.projects.filter((p) => p.id === 999999 || (victim && p.id === victim.id))
    if (residue.length) throw new Error('名单里还有自检用的靶子：' + JSON.stringify(residue))
    return { projects: snap.blocklist.projects.length, users: snap.blocklist.users.length }
  })

  await step('名单落盘位置可写', () => {
    const file = store.file()
    fs.writeFileSync(path.join(OUT(), 'store-path.txt'), file)
    return { storeFile: file, exists: fs.existsSync(file) }
  })

  const failed = report.steps.filter((s) => !s.ok)
  report.finishedAt = new Date().toISOString()
  report.pass = failed.length === 0
  clearTimeout(watchdog)
  dump()
  console.log(report.pass ? 'SELFTEST PASS' : 'SELFTEST FAIL: ' + failed.map((f) => f.name).join(' | '))
  return report
}

module.exports = { run }
