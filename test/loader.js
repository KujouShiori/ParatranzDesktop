'use strict'

// 注入用的是文本化的函数源码，不是 require 进来的对象。
// 这里检查「将要被打进页面的那串字符」本身能编译、能跑，避免测试全绿而客户端坏掉。
const loader = require('../src/inject/loader')

let failed = 0
let passed = 0

function check(name, cond, extra) {
  if (cond) passed++
  else {
    failed++
    console.log('FAIL  ' + name + (extra ? '  ' + JSON.stringify(extra) : ''))
  }
}

const src = loader.functionSource()
check('切片保留 function 关键字', src.startsWith('function'), { head: src.slice(0, 40) })
check('切片是完整函数体', src.trim().endsWith('}'), { tail: src.slice(-40) })

let fn
try {
  fn = new Function('return (' + src + ')')()
} catch (e) {
  fn = null
  check('注入字符串可编译', false, { error: String(e && e.message ? e.message : e) })
}
check('注入字符串可编译', typeof fn === 'function')
check('loadEngine 返回函数', typeof loader.loadEngine() === 'function')

// 用最小假环境跑一遍，确认这段文本真的能装起来
if (fn) {
  const listeners = {}
  const el = () => ({
    style: {}, className: '', appendChild() {}, removeChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return null }, removeAttribute() {}, addEventListener() {},
    querySelectorAll: () => [], classList: { add() {}, remove() {} }, parentElement: null, children: []
  })
  const w = {
    location: { href: 'https://paratranz.cn/projects', origin: 'https://paratranz.cn' },
    Promise: Promise,
    Event: class { constructor(t) { this.type = t } },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f) },
    removeEventListener() {},
    postMessage() {},
    history: { pushState() {}, replaceState() {} },
    MutationObserver: undefined
  }
  const d = {
    readyState: 'complete', title: '', head: el(), body: el(), documentElement: el(),
    createElement: el, createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement_: el()
  }
  let res = null
  let err = null
  try {
    res = fn({ win: w, doc: d, mode: 'full', token: 'T', handleName: '__h', rules: { projectIds: [1] } })
  } catch (e) {
    err = e
  }
  check('假环境下引擎装起来', !err, { error: err && String(err.message || err) })
  check('诊断出口挂上了', typeof w.__ptShieldInfo === 'function')
  check('规则句柄挂上了', typeof w.__h === 'function')
  if (typeof w.__ptShieldInfo === 'function') {
    const info = w.__ptShieldInfo()
    check('报告了名单状态', info.empty === false && info.projects[0] === 1, info)
  }
}

console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
