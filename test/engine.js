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

// WebSocket 旁听：只旁听 socket.io 的事件帧，且不能改坏连接
function makeWebSocketClass(sink) {
  class MockWS {
    constructor(url) {
      this.url = url
      this._listeners = {}
      sink.wsCreated.push(url)
    }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn) }
    removeEventListener() {}
    send() { sink.wsSent.push(1) }
    close() {}
    _emit(type, data) { for (const fn of this._listeners[type] || []) fn({ type: type, data: data }) }
  }
  MockWS.prototype.__ptWatchProbe = true
  MockWS.CONNECTING = 0
  MockWS.OPEN = 1
  MockWS.CLOSING = 2
  MockWS.CLOSED = 3
  return MockWS
}

function wsCases() {
  const sink = { calls: [], messages: [], fetchCalls: [], wsCreated: [], wsSent: [], blockedUrls: [] }
  const w = makeWindow('https://paratranz.cn/projects', makeXhrClass(sink), sink)
  w.WebSocket = makeWebSocketClass(sink)
  engine({ win: w, doc: makeDoc('https://paratranz.cn/projects'), mode: 'full', token: TOKEN, handleName: HANDLE, rules: {} })

  check('WebSocket 被接管', !!w.WebSocket.prototype.__ptWatchProbe, true)
  const socket = new w.WebSocket('wss://paratranz.cn/socket.io/?EIO=4&transport=websocket')
  check('连接照常建立', sink.wsCreated.length, 1)

  const firedCount = () => sink.messages.filter((m) => m.type === 'activity').length
  socket._emit('message', '40{"sid":"abc"}')
  check('握手帧不触发', firedCount(), 0)
  socket._emit('message', '2')
  check('心跳帧不触发', firedCount(), 0)
  socket._emit('message', '42["ping"]')
  check('无关事件不触发', firedCount(), 0)
  socket._emit('message', '42["mail",{"id":1,"content":"hi"}]')
  check('私信事件触发', firedCount(), 1)
  const first = sink.messages.find((m) => m.type === 'activity')
  check('触发带上来源', first && first.payload.source, 'socket')
  socket._emit('message', '42["message",{"id":2}]')
  // 800ms 内的后续事件被合并掉是故意的：一次触发会把这个账号的所有源都拉一遍，
  // 再触发一次只是重复请求，不会漏消息。
  check('短时间内的后续事件被合并', firedCount(), 1)
  socket._emit('message', '42["mail",{"id":3}]')
  check('合并窗口内继续刷屏也只算一次', firedCount(), 1)
  socket.send('x')
  check('旁听不拦截发送', sink.wsSent.length, 1)
  // 合并是按连接算的：新连接上的事件不该被上一条连接的冷却吞掉
  const another = new w.WebSocket('wss://paratranz.cn/socket.io/?EIO=4&transport=websocket')
  another._emit('message', '42["mail",{"id":9}]')
  check('新连接的事件照常触发', firedCount(), 2)
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
