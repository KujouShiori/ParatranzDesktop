'use strict'

const fs = require('fs')
const path = require('path')
const engine = require('../src/inject/loader').loadEngine()

let failed = 0
let passed = 0

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) passed++
  else {
    failed++
    console.log('FAIL  ' + name + '\n      expected ' + e + '\n      actual   ' + a)
  }
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
}

function makeXhrClass(sink) {
  class MockXHR {
    constructor() {
      this._ready = 1
      this._status = 200
      this._statusText = 'OK'
      this._text = ''
      this.responseType = ''
      this._listeners = {}
      this._headers = { 'content-type': 'application/json; charset=utf-8' }
    }
    open(method, url) {
      this._method = method
      this._url = url
    }
    send() {
      sink.calls.push(this._url)
      if (sink.blockedUrls.includes(this._url)) throw new Error('网络请求不该发生: ' + this._url)
      this._status = sink.status
      this._statusText = sink.statusText || 'OK'
      this._text = sink.responseText
      this._ready = 4
      this._emit('readystatechange')
      this._emit('load')
    }
    _emit(type) {
      const h = this['on' + type]
      if (h) h.call(this, { type: type })
      const list = this._listeners[type] || []
      for (const fn of list) fn.call(this, { type: type })
    }
    addEventListener(type, fn) {
      ;(this._listeners[type] = this._listeners[type] || []).push(fn)
    }
    removeEventListener() {}
    dispatchEvent(ev) {
      this._emit(ev.type)
      return true
    }
    getAllResponseHeaders() { return 'content-type: application/json\r\n' }
    getResponseHeader(n) { return n.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null }
    setRequestHeader() {}
    abort() {}
    get responseText() { return this._text }
    get response() { return this.responseType === 'json' ? JSON.parse(this._text) : this._text }
    get status() { return this._status }
    get statusText() { return this._statusText }
    get readyState() { return this._ready }
  }
  MockXHR.UNSENT = 0
  MockXHR.OPENED = 1
  MockXHR.HEADERS_RECEIVED = 2
  MockXHR.LOADING = 3
  MockXHR.DONE = 4
  return MockXHR
}

function makeWindow(url, XhrClass, sink, withFetch) {
  const listeners = {}
  const w = {
    XMLHttpRequest: XhrClass,
    location: { href: url, origin: 'https://paratranz.cn' },
    Promise: Promise,
    Event: class { constructor(t) { this.type = t } },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn) },
    removeEventListener: () => {},
    postMessage: (msg) => { sink.messages.push(msg) },
    MutationObserver: undefined,
    Response: undefined,
    _listeners: listeners
  }
  if (withFetch) {
    w.Response = Response
    w.fetch = async function (input) {
      const target = typeof input === 'string' ? input : input.url
      sink.fetchCalls.push(target)
      if (sink.fetchThrows) throw new Error('network down')
      return new Response(sink.responseText, {
        status: sink.status || 200,
        statusText: sink.statusText || 'OK',
        headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, sink.extraHeaders || {})
      })
    }
  }
  w.globalThis = w
  return w
}

function makeDoc(url) {
  const el = () => ({
    style: {},
    className: '',
    childNodes: [],
    appendChild() {},
    removeChild() {},
    remove() {},
    setAttribute() {},
    getAttribute() { return null },
    removeAttribute() {},
    addEventListener() {},
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ height: 40 }),
    parentElement: null,
    children: []
  })
  return {
    readyState: 'complete',
    title: '测试页面',
    head: el(),
    body: el(),
    documentElement: el(),
    defaultView: null,
    createElement: el,
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    documentElement_: true,
    URL: url
  }
}

const TOKEN = 'test-token-123'
const HANDLE = '__pt_handle_test'

function boot(url, responseText, opts) {
  const sink = { calls: [], messages: [], fetchCalls: [], blockedUrls: (opts && opts.blockedUrls) || [] }
  const XhrClass = makeXhrClass(sink)
  const w = makeWindow(url, XhrClass, sink)
  const d = makeDoc(url)
  const res = engine({
    win: w,
    doc: d,
    mode: 'full',
    token: TOKEN,
    handleName: HANDLE,
    rules: (opts && opts.rules) || {}
  })
  sink.status = (opts && opts.status) || 200
  sink.responseText = responseText
  return { w: w, d: d, sink: sink, res: res, XhrClass: XhrClass }
}

function readXhr(w, url, responseType) {
  return new Promise(function (resolve) {
    const xhr = new w.XMLHttpRequest()
    xhr.open('GET', url)
    if (responseType) xhr.responseType = responseType
    xhr.onload = function () {
      resolve({ status: xhr.status, text: xhr.responseText, response: xhr.response, readyState: xhr.readyState })
    }
    xhr.send(null)
  })
}

// WebSocket 旁听：钩子打在原型上，所以「引擎装好之前就已经连上的 socket」也能旁听到
function makeWebSocketClass(sink) {
  class MockWS {
    constructor(url) {
      this.url = url
      this._listeners = {}
      this.__om = null
      sink.wsCreated.push(url)
    }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn) }
    removeEventListener() {}
    send() { sink.wsSent.push(1) }
    close() {}
    get onmessage() { return this.__om }
    set onmessage(fn) { this.__om = fn }
    _emit(type, data) {
      const ev = { type: type, data: data }
      if (type === 'message' && typeof this.__om === 'function') this.__om.call(this, ev)
      for (const fn of this._listeners[type] || []) fn.call(this, ev)
    }
  }
  MockWS.CONNECTING = 0
  MockWS.OPEN = 1
  MockWS.CLOSING = 2
  MockWS.CLOSED = 3
  return MockWS
}

function wsCases() {
  const sink = { calls: [], messages: [], fetchCalls: [], wsCreated: [], wsSent: [], blockedUrls: [] }
  const w = makeWindow('https://paratranz.cn/projects', makeXhrClass(sink), sink)
  const WSClass = makeWebSocketClass(sink)
  w.WebSocket = WSClass

  // 站点先建连，引擎后注入 —— 这正是 dom-ready 兜底注入时的真实顺序
  const early = new w.WebSocket('wss://paratranz.cn/socket.io/?EIO=4&transport=websocket')
  early.onmessage = function (ev) { sink.earlyHandlerSaw = ev.data }

  let clock = 1000
  engine({ win: w, doc: makeDoc('https://paratranz.cn/projects'), mode: 'full', token: TOKEN, handleName: HANDLE, rules: {}, now: () => clock })

  const firedCount = () => sink.messages.filter((m) => m.type === 'activity').length

  // 站点在兜底注入之前就赋过 onmessage 的话，原型 setter 追不上已经存在的连接；
  // 这条只保证「注入之后的赋值」被旁听到（socket.io 每次重连都会重新赋值）。
  early._emit('message', '42["mail",{"id":1}]')
  check('注入前已赋值的旧连接不强求旁听', firedCount(), 0)

  const reconnected = new w.WebSocket('wss://paratranz.cn/socket.io/?EIO=4&transport=websocket')
  reconnected.onmessage = function (ev) { sink.reconnectSaw = ev.data }
  reconnected._emit('message', '42["mail",{"id":7}]')
  check('注入后新建并赋值的连接能旁听到', firedCount(), 1)
  check('站点自己的 onmessage 照常收到数据', sink.reconnectSaw, '42["mail",{"id":7}]')

  const later = new w.WebSocket('wss://paratranz.cn/socket.io/?EIO=4&transport=websocket')
  later.addEventListener('message', function (ev) { sink.laterSaw = ev.data })
  const before = firedCount()
  later._emit('message', '42["mail",{"id":2}]')
  check('800ms 内连发被合并（一次触发会拉全部源）', firedCount(), before)
  check('addEventListener 注册的站点回调照常收到', sink.laterSaw, '42["mail",{"id":2}]')

  const cold = new w.WebSocket('wss://paratranz.cn/socket.io/?EIO=4&transport=websocket')
  cold._emit('message', '40{"sid":"abc"}')
  check('握手帧不触发', firedCount(), before)
  cold._emit('message', '2')
  check('心跳帧不触发', firedCount(), before)
  cold._emit('message', '42["ping"]')
  check('无关事件不触发', firedCount(), before)

  sink.messages.length = 0
  clock += 5000
  const fresh = new w.WebSocket('wss://paratranz.cn/socket.io/?EIO=4&transport=websocket')
  fresh.addEventListener('message', function () {})
  fresh._emit('message', '42["message",{"id":9}]')
  check('冷却过后新事件仍能触发', firedCount(), 1)
  fresh.send('x')
  check('旁听不拦截发送', sink.wsSent.length, 1)
}

async function main() {
  const list = fixture('projects_page_1_pageSize_2.json')
  wsCases()

  // 空名单时零开销：不改写响应
  {
    const ctx = boot('https://paratranz.cn/projects', JSON.stringify(list), { rules: {} })
    const r = await readXhr(ctx.w, '/api/projects?page=1&pageSize=2')
    check('empty rules leaves body untouched', r.text, JSON.stringify(list))
    check('empty rules still passes through', ctx.sink.calls.length, 1)
  }

  // 列表接口过滤掉被屏蔽项目
  {
    const blockedId = list.results[1].id
    const ctx = boot('https://paratranz.cn/projects', JSON.stringify(list), { rules: { projectIds: [blockedId] } })
    const r = await readXhr(ctx.w, '/api/projects?page=1&pageSize=2')
    const got = JSON.parse(r.text)
    check('xhr filters listing', got.results.map((p) => p.id), [list.results[0].id])
    check('xhr filter keeps rowCount synced', got.rowCount, list.rowCount - 1)
  }

  // 硬屏蔽：请求根本不发出去，页面拿到 404
  {
    const ctx = boot('https://paratranz.cn/projects/10709', '{}', {
      rules: { projectIds: [10709] },
      blockedUrls: ['/api/projects/10709']
    })
    const r = await readXhr(ctx.w, '/api/projects/10709')
    check('hard block issues no network call', ctx.sink.calls.length, 0)
    check('hard block reports 404', r.status, 404)
    check('hard block reports DONE', r.readyState, 4)
    check('hard block body matches site contract', JSON.parse(r.text), { message: 'Project 10709 does not exist' })
  }

  // 子资源同样不发请求
  {
    const ctx = boot('https://paratranz.cn/projects/10709/terms', '{}', {
      rules: { projectIds: [10709] },
      blockedUrls: ['/api/projects/10709/terms?page=1']
    })
    await readXhr(ctx.w, '/api/projects/10709/terms?page=1')
    check('sub resource hard blocked', ctx.sink.calls.length, 0)
  }

  // responseType=json 时也要过滤
  {
    const members = fixture('projects_10709_members_page_1_pageSize_3.json')
    const victim = members[3].user.id
    const ctx = boot('https://paratranz.cn/projects/10709/members', JSON.stringify(members), { rules: { userIds: [victim] } })
    const r = await readXhr(ctx.w, '/api/projects/10709/members', 'json')
    const arr = Array.isArray(r.response) ? r.response : r.response.results
    check('json responseType filtered', arr.some((m) => m.user && m.user.id === victim), false)
    check('json responseType drops exactly one', arr.length, members.length - 1)
  }

  // socket.io 长轮询响应不能被当成 API 改写
  {
    const payload = '\x00' + JSON.stringify([{ type: 'message', data: 'keepme' }])
    const ctx = boot('https://paratranz.cn/', payload, { rules: { userIds: [1] } })
    const r = await readXhr(ctx.w, '/api/socket.io/?EIO=3&transport=polling')
    check('socket.io payload untouched', r.text, payload)
  }

  // 非 JSON 响应原样返回
  {
    const ctx = boot('https://paratranz.cn/', 'not json at all', { rules: { userIds: [1] } })
    const r = await readXhr(ctx.w, '/api/projects/10709/logo.png')
    check('non-json body untouched', r.text, 'not json at all')
  }

  // 热更新名单：token 不对就不接受
  {
    const ctx = boot('https://paratranz.cn/projects', JSON.stringify(list), { rules: {} })
    check('applyRules rejects wrong token', ctx.w[HANDLE]({ projectIds: [18245] }, 'wrong'), false)
    check('applyRules accepts right token', ctx.w[HANDLE]({ projectIds: [18245] }, TOKEN), true)
    const r = await readXhr(ctx.w, '/api/projects')
    check('rules hot update takes effect', JSON.parse(r.text).results.map((p) => p.id), [list.results[1].id])
  }

  // 意图消息只在真实点击时发出
  {
    const ctx = boot('https://paratranz.cn/projects/10709', '{}', { rules: {} })
    let captured = null
    ctx.w._listeners.message // 主世界不监听，只检查 sendIntent 的行为
    captured = ctx.sink.messages.slice()
    check('no intent without click', captured.length, 0)
  }

  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

main().catch(function (e) {
  console.log('engine test crashed: ' + (e && e.stack ? e.stack : e))
  process.exit(1)
})
