'use strict'

const fs = require('fs')
const path = require('path')

const SRC_PATH = path.join(__dirname, 'engine.js')
const EXPORT_HEAD = 'module.exports = '
const MARKER = EXPORT_HEAD + 'function'

// 引擎要么被整段序列化进主世界（executeJavaScript），要么由 preload 交给
// mainWorldContextBridge。两条路都要求 engine.js 保持单个函数字面量的写法。
function functionSource() {
  const text = fs.readFileSync(SRC_PATH, 'utf8')
  const at = text.indexOf(MARKER)
  if (at < 0) throw new Error('engine.js 不再是 "' + MARKER + ' ..." 形式，注入会失败')
  // 只去掉 "module.exports = "，必须把 function 关键字留下
  const src = text.slice(at + EXPORT_HEAD.length).replace(/\s+$/, '')
  if (!src.startsWith('function')) throw new Error('引擎源码切片跑偏，首词不是 function：' + src.slice(0, 40))
  return src
}

function loadEngine() {
  const fn = new Function('return (' + functionSource() + ')')()
  if (typeof fn !== 'function') throw new Error('引擎源码没能还原成函数')
  return fn
}

module.exports = { functionSource, loadEngine }
