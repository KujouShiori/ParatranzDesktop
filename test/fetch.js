'use strict'

// 站点 axios 的适配器是 fetch（bundle 里：`'fetch' in window && !window.isDev ? 'fetch' : 'xhr'`），
// 所以 fetch 是屏蔽引擎的主路径，单独覆盖。
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

const TOKEN = 'fetch-token'
const HANDLE = '__pt_fetch_handle'

function stubDoc() {
  const el = () => ({
    style: {}, className: '', childNodes: [], appendChild() {}, removeChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return null }, removeAttribute() {}, addEventListener() {},
    querySelectorAll: () => [], getBoundingClientRect: () => ({ height: 40 }), parentElement: null, children: [],
    classList: { add() {}, remove() {} }
  })
  return {
    readyState: 'complete', title: '', head: null, body: el(), documentElement: el(),
    createElement: el, createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement_: true
  }
}

function boot(responseText, rulesState, extraHeaders) {
  const sink = { fetchCalls: [], responseText: responseText, status: 200, extraHeaders: extraHeaders || {}, throws: false }
  const w = {
    location: { href: 'https://paratranz.cn/projects', origin: 'https://paratranz.cn' },
    Promise: Promise,
    Response: Response,
    Event: class { constructor(t) { this.type = t } },
    XMLHttpRequest: undefined,
    MutationObserver: undefined,
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    history: { pushState() {}, replaceState() {}, back() {} }
  }
  w.fetch = async function (input) {
    const url = typeof input === 'string' ? input : input.url
    sink.fetchCalls.push(url)
    if (sink.throws) throw new TypeError('Failed to fetch')
    return new Response(sink.responseText, {
      status: sink.status,
      statusText: 'OK',
      headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, sink.extraHeaders)
    })
  }
  engine({ win: w, doc: stubDoc(), mode: 'full', token: TOKEN, handleName: HANDLE, rules: rulesState || {} })
  return { w: w, sink: sink }
}

async function get(w, url) {
  const res = await w.fetch(url)
  const text = await res.text()
  return { status: res.status, text: text, headers: res.headers }
}

async function main() {
  const list = fixture('projects_page_1_pageSize_2.json')
  const members = fixture('projects_10709_members_page_1_pageSize_3.json')

  {
    const ctx = boot(JSON.stringify(list), { projectIds: [list.results[1].id] })
    const r = await get(ctx.w, '/api/projects?page=1&pageSize=2')
    check('fetch 过滤列表', JSON.parse(r.text).results.map((p) => p.id), [list.results[0].id])
    check('fetch 过滤后 rowCount 同步', JSON.parse(r.text).rowCount, list.rowCount - 1)
    check('fetch 仍然发出请求', ctx.sink.fetchCalls.length, 1)
  }

  {
    const ctx = boot(JSON.stringify(list), {})
    const r = await get(ctx.w, '/api/projects')
    check('fetch 空名单零改写', r.text, JSON.stringify(list))
  }

  {
    const ctx = boot('{}', { projectIds: [10709] })
    const r = await get(ctx.w, '/api/projects/10709/terms?page=1')
    check('fetch 硬屏蔽不发请求', ctx.sink.fetchCalls.length, 0)
    check('fetch 硬屏蔽 404', r.status, 404)
    check('fetch 硬屏蔽契约体', JSON.parse(r.text), { message: 'Project 10709 does not exist' })
  }

  {
    const ctx = boot(JSON.stringify(list), { projectIds: [list.results[0].id] }, { 'x-session-sync': 'user,permissions' })
    const r = await get(ctx.w, '/api/projects')
    check('fetch 保留 x-session-sync', r.headers.get('x-session-sync'), 'user,permissions')
    check('fetch 保留 content-type', /json/i.test(r.headers.get('content-type') || ''), true)
  }

  {
    const ctx = boot('binary-ish', { projectIds: [1] }, { 'content-type': 'application/octet-stream' })
    const r = await get(ctx.w, '/api/projects/10709/files/1/translation')
    check('fetch 非 JSON 原样', r.text, 'binary-ish')
  }

  {
    const ctx = boot('\x00[{"type":"message"}]', { userIds: [1] })
    const r = await get(ctx.w, '/api/socket.io/?EIO=4&transport=polling')
    check('fetch 不动 socket.io', r.text, '\x00[{"type":"message"}]')
  }

  {
    const ctx = boot(JSON.stringify({ id: 7, username: 'me', nickname: '我' }), { userIds: [7] })
    const r = await get(ctx.w, '/api/account')
    check('fetch 不改写 /account', JSON.parse(r.text).username, 'me')
  }

  {
    const victim = members[3].user.id
    const ctx = boot(JSON.stringify(members), { userIds: [victim] })
    const r = await get(ctx.w, '/api/projects/10709/members')
    const arr = JSON.parse(r.text)
    check('fetch 成员整行剔除', arr.length, members.length - 1)
    check('fetch 被屏蔽者不再出现', arr.some((m) => m.user && m.user.id === victim), false)
  }

  {
    const ctx = boot(JSON.stringify(list), { projectIds: [1] })
    ctx.sink.throws = true
    let threw = false
    try { await get(ctx.w, '/api/projects') } catch (e) { threw = true }
    check('fetch 网络错误照常冒泡', threw, true)
  }

  {
    const ctx = boot(JSON.stringify(list), {})
    ctx.w[HANDLE]({ projectIds: [list.results[0].id] }, 'wrong-token')
    const r = await get(ctx.w, '/api/projects')
    check('fetch 错误 token 不下发规则', JSON.parse(r.text).results.length, list.results.length)
    ctx.w[HANDLE]({ projectIds: [list.results[0].id] }, TOKEN)
    const r2 = await get(ctx.w, '/api/projects')
    check('fetch 正确 token 立刻生效', JSON.parse(r2.text).results.map((p) => p.id), [list.results[1].id])
  }

  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.log('fetch test crashed: ' + (e && e.stack ? e.stack : e))
  process.exit(1)
})
