'use strict'

const fs = require('fs')
const path = require('path')
const engine = require('../src/inject/loader').loadEngine()
const P = require('../src/shared/pure')

const CASES = [
  { file: 'projects_page_1_pageSize_2.json', url: '/api/projects?page=1&pageSize=2', block: (j) => ({ projects: [{ id: j.results[0].id }] }) },
  { file: 'projects_page_1_pageSize_2.json', url: '/api/projects?page=1&pageSize=2', block: (j) => ({ projects: [{ id: j.results[0].id }, { id: j.results[1].id }] }) },
  { file: 'projects_10709.json', url: '/api/projects/18857', block: () => ({ projects: [{ id: 10709 }] }) },
  { file: 'projects_10709_members_page_1_pageSize_3.json', url: '/api/projects/10709/members', block: (j) => ({ users: [{ id: j[2].user.id }, { username: j[3].user.username }] }) },
  { file: 'projects_10709_members_page_1_pageSize_3.json', url: '/api/projects/10709/members', block: (j) => ({ projects: [{ id: 10709 }] }) },
  { file: 'projects_10709_members_page_1_pageSize_3.json', url: '/api/projects/10709/members', block: (j) => ({ projects: [{ id: j[0].id }] }) },
  { file: 'users_leaderboard_page_1_pageSize_2.json', url: '/api/users/leaderboard', block: (j) => ({ users: [{ id: j[0].id }, { username: j[1].username }] }) },
  { file: 'users_leaderboard_page_1_pageSize_2.json', url: '/api/users/leaderboard', block: () => ({ users: [{ username: 'nosuch' }] }) },
  { file: 'mails_list.json', url: '/api/mails?page=1', block: () => ({ users: [{ id: 900001 }] }) },
  { file: 'mails_list.json', url: '/api/mails?page=1', block: () => ({ users: [{ id: 1 }] }) },
  { file: 'mails_list.json', url: '/api/mails?page=1', block: () => ({ projects: [{ id: 18245 }] }) },
  { file: 'messages_list.json', url: '/api/messages?page=1', block: () => ({ users: [{ id: 900001 }] }) },
  { file: 'messages_list.json', url: '/api/messages?page=1', block: () => ({ projects: [{ id: 777 }] }) },
  { file: 'messages_list.json', url: '/api/messages?page=1', block: () => ({ users: [{ username: 'other-guy' }] }) },
  { file: 'projects_10709_terms_page_1_pageSize_2.json', url: '/api/projects/10709/terms', block: () => ({ users: [{ id: 1 }] }) },
  { file: 'files_list.json', url: '/api/projects/18245/files', block: () => ({ projects: [{ id: 18245 }] }) },
  { file: 'files_list.json', url: '/api/projects/5000/files', block: () => ({ projects: [{ id: 777 }] }) },
  { file: 'term_values.json', url: '/api/projects/18245/terms', block: () => ({ projects: [{ id: 18245 }] }) },
  { file: 'term_values.json', url: '/api/projects/5000/terms', block: () => ({ users: [{ id: 4242 }] }) },
  {
    file: 'synthetic_terms_with_authors.json',
    url: '/api/projects/10709/terms?page=1',
    block: () => ({ users: [{ id: 42 }], projects: [{ id: 999 }] })
  },
  {
    file: 'synthetic_terms_with_authors.json',
    url: '/api/projects/10709/comments',
    block: () => ({ users: [{ id: 42 }] })
  },
  {
    file: 'synthetic_notifications.json',
    url: '/api/broadcasts?page=1',
    block: () => ({ users: [{ username: 'spammer' }], projects: [{ id: 18245 }] })
  }
]

function makeXhrClass(sink) {
  class MockXHR {
    constructor() {
      this._ready = 1
      this._status = 200
      this._text = ''
      this.responseType = 'text'
      this._listeners = {}
    }
    open(m, url) { this._url = url }
    send() {
      this._ready = 4
      this._text = sink.responseText
      this._emit('readystatechange')
      this._emit('load')
    }
    _emit(type) {
      const h = this['on' + type]
      if (h) h.call(this, { type: type })
      for (const fn of this._listeners[type] || []) fn.call(this, { type: type })
    }
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn) }
    removeEventListener() {}
    dispatchEvent(ev) { this._emit(ev.type); return true }
    getAllResponseHeaders() { return 'content-type: application/json\r\n' }
    getResponseHeader(n) { return String(n).toLowerCase() === 'content-type' ? 'application/json' : null }
    setRequestHeader() {}
    abort() {}
    get responseText() { return this._text }
    get response() { return this._text }
    get status() { return this._status }
    get statusText() { return 'OK' }
    get readyState() { return this._ready }
  }
  MockXHR.UNSENT = 0
  MockXHR.OPENED = 1
  MockXHR.HEADERS_RECEIVED = 2
  MockXHR.LOADING = 3
  MockXHR.DONE = 4
  return MockXHR
}

function stubDoc() {
  const el = () => ({
    style: {}, className: '', childNodes: [], appendChild() {}, removeChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return null }, removeAttribute() {}, addEventListener() {},
    querySelectorAll: () => [], getBoundingClientRect: () => ({ height: 40 }), parentElement: null, children: []
  })
  return {
    readyState: 'complete', title: '', head: null, body: null, documentElement: el(),
    createElement: el, createTextNode: (t) => ({ nodeType: 3, textContent: t }), getElementById: () => null, querySelectorAll: () => [], addEventListener() {}
  }
}

function runThroughEngine(rawText, url, rulesState) {
  const sink = { blocked: true, responseText: rawText }
  const XhrClass = makeXhrClass(sink)
  const listeners = {}
  const w = {
    XMLHttpRequest: XhrClass,
    location: { href: 'https://paratranz.cn/x', origin: 'https://paratranz.cn' },
    Promise: Promise,
    Event: class { constructor(t) { this.type = t } },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn) },
    removeEventListener() {},
    postMessage() {},
    Response: undefined,
    MutationObserver: undefined
  }
  engine({ win: w, doc: stubDoc(), mode: 'full', token: 'T', handleName: '__h', rules: rulesState })
  const xhr = new w.XMLHttpRequest()
  xhr.open('GET', url)
  let out = null
  xhr.onload = function () { out = { status: xhr.status, text: xhr.responseText } }
  xhr.send(null)
  if (out === null) out = { status: xhr.status, text: xhr.responseText }
  return out
}

function rulesStateOf(block) {
  const r = P.normalizeRules(block)
  return P.buildRulesState(r)
}

function main() {
  const dir = path.join(__dirname, 'fixtures')
  let failed = 0
  let checked = 0

  for (const c of CASES) {
    const raw = fs.readFileSync(path.join(dir, c.file), 'utf8')
    const state = rulesStateOf(c.block(JSON.parse(raw)))
    const engineOut = runThroughEngine(raw, c.url, state)
    const info = P.parseSiteUrl(c.url)
    if (engineOut.status === 404) {
      checked++
      if (!P.urlTargetsBlockedProject(P.normalizeRules(c.block(JSON.parse(raw))), c.url)) {
        failed++
        console.log('FAIL parity ' + c.file + ' ' + c.url + ' : engine hard blocked, pure did not')
      }
      continue
    }
    const copy = JSON.parse(raw)
    P.filterJson(copy, P.normalizeRules(c.block(JSON.parse(raw))), info)
    const pureText = JSON.stringify(copy)
    checked++
    if (pureText !== engineOut.text) {
      failed++
      console.log('FAIL parity ' + c.file + ' ' + c.url)
      console.log('  engine ' + engineOut.text.slice(0, 400))
      console.log('  pure   ' + pureText.slice(0, 400))
    }
  }

  console.log((failed ? 'FAILED ' : 'ok ') + (checked - failed) + '/' + checked + ' fixtures match')
  process.exit(failed ? 1 : 0)
}

main()
