'use strict'
// 从 Chromium 磁盘缓存里把看起来像接口响应的 JSON 抠出来，只输出字段名与值类型，
// 任何字符串内容都不打印，避免把私信正文带到屏幕上。
const fs = require('fs')

const file = process.argv[2]
const buf = fs.readFileSync(file)
const text = buf.toString('latin1')

function shapeOf(v, depth) {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : []
  if (v === null) return 'null'
  if (typeof v === 'object') {
    if (depth > 3) return 'object'
    const out = {}
    for (const k of Object.keys(v)) out[k] = shapeOf(v[k], depth + 1)
    return out
  }
  if (typeof v === 'string') return 'string(' + v.length + ')'
  return typeof v
}

const seen = new Set()
const found = []
let idx = 0
while (true) {
  const start = text.indexOf('{"', idx)
  if (start < 0) break
  idx = start + 2
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  const limit = Math.min(text.length, start + 400000)
  for (let i = start; i < limit; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) continue
  const raw = text.slice(start, end)
  if (raw.length < 40 || raw.length > 300000) continue
  let obj
  try {
    obj = JSON.parse(raw)
  } catch (e) {
    continue
  }
  const keys = Object.keys(obj).sort().join(',')
  if (seen.has(keys)) continue
  seen.add(keys)
  found.push(obj)
}

const interesting = found.filter((o) => {
  const s = JSON.stringify(Object.keys(o))
  return /user|content|mail|title|createdAt|id|unread|conv/i.test(s)
})

console.log('total JSON objects parsed:', found.length, '| shape-distinct interesting:', interesting.length)
for (const o of interesting.slice(0, 12)) {
  console.log('----')
  console.log(JSON.stringify(shapeOf(o, 0), null, 1).slice(0, 1400))
}
