'use strict'

const pure = require('./pure')

// 提醒的取数逻辑要兼容站点多种返回结构，而且这些接口只有登录后才拿得到真实样本，
// 所以判定单独放这里，可以在 Node 里用合成样本测，不必启动 Electron。

function itemsOf(json) {
  if (Array.isArray(json)) return json
  if (!json || typeof json !== 'object') return []
  for (const key of ['results', 'data', 'items', 'list', 'rows', 'records']) {
    if (Array.isArray(json[key])) return json[key]
  }
  return []
}

function idOf(item, index) {
  if (item && (typeof item.id === 'number' || typeof item.id === 'string')) return String(item.id)
  return 'idx-' + index
}

function firstString(item, keys) {
  for (const k of keys) {
    const v = item && item[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return ''
}

function hash(text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// 只用 id 去重会漏：私信列表返回的可能是「会话」，同一个人再发一条时 id 不变。
// 所以把时间戳和正文摘要一起算进键里，正文没变才算重复。
function keyOf(item, index) {
  if (!item || typeof item !== 'object') return 'idx-' + index
  const id = idOf(item, index)
  const stamp = firstString(item, ['updatedAt', 'lastAt', 'lastTime', 'sentAt', 'createdAt', 'time', 'date'])
  const body = firstString(item, ['lastContent', 'lastMessage', 'content', 'body', 'text', 'message', 'subject', 'title'])
  const digest = body ? body.length + ':' + hash(body.slice(0, 120)) : ''
  if (!stamp && !digest) return id
  return id + '|' + stamp + '|' + digest
}

function actors(item) {
  const out = []
  for (const key of ['user', 'from', 'author', 'creator', 'sender']) {
    const v = item && item[key]
    if (v && typeof v === 'object') out.push(v)
  }
  if (item && typeof item.username === 'string') out.push(item)
  return out
}

function projectIdsOf(item) {
  const out = []
  for (const key of Object.keys(item || {})) {
    if (/^project_?id$|^project$/i.test(key)) {
      const v = item[key]
      if (typeof v === 'number' || typeof v === 'string') out.push(v)
    }
  }
  if (item && item.project && typeof item.project === 'object' && item.project.id) out.push(item.project.id)
  return out
}

function shouldSkip(item, rules) {
  for (const id of projectIdsOf(item)) if (pure.projectBlocked(rules, id)) return true
  for (const u of actors(item)) if (pure.userEntityBlocked(rules, u)) return true
  return false
}

const KIND_LABEL = { mails: '站内信', messages: '消息', broadcasts: '公告' }

function titleOf(item, feedId) {
  const proj = (item && (item.projectName || (item.project && item.project.name))) || ''
  const who = actors(item).map((u) => u.nickname || u.username).filter(Boolean)[0] || ''
  const parts = []
  if (proj) parts.push('[' + proj + ']')
  if (who) parts.push(who)
  parts.push(KIND_LABEL[feedId] || '新消息')
  return parts.join(' ')
}

function bodyOf(item) {
  for (const key of ['title', 'subject', 'content', 'body', 'text', 'message', 'zh', 'value']) {
    const v = item && item[key]
    if (typeof v === 'string' && v.trim()) {
      const s = v.replace(/\s+/g, ' ').trim()
      return s.length > 120 ? s.slice(0, 120) + '…' : s
    }
  }
  return ''
}

module.exports = { actors, bodyOf, idOf, itemsOf, keyOf, projectIdsOf, shouldSkip, titleOf }
