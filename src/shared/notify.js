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

// 私信与站内消息的真实字段（实测）：fromUser / toUser 是完整用户对象，
// from / to / uid 是数字用户 id，messages 里有些条目只有数字 from 而没有 fromUser。
function actors(item) {
  const out = []
  for (const key of ['fromUser', 'user', 'toUser', 'from', 'author', 'creator', 'sender']) {
    const v = item && item[key]
    if (v && typeof v === 'object') out.push(v)
  }
  if (item && typeof item.username === 'string') out.push(item)
  return out
}

function actorIds(item) {
  const out = []
  // 用户 id 是小整数；history 等接口的 from / to 是 1e12 量级时间戳，天然不会撞上
  for (const key of ['from', 'uid', 'userId', 'user_id']) {
    if (item && (key in item)) out.push(item[key])
  }
  for (const u of actors(item)) if (u && Number.isFinite(Number(u.id))) out.push(u.id)
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
  // messages 的跳转信息在 link 里：{ id, title, project }
  const link = item && item.link
  if (link && typeof link === 'object') {
    if (Number.isFinite(Number(link.project))) out.push(link.project)
    if (link.project && typeof link.project === 'object' && link.project.id) out.push(link.project.id)
  }
  return out
}

function shouldSkip(item, rules) {
  for (const id of projectIdsOf(item)) if (pure.projectBlocked(rules, id)) return true
  for (const u of actors(item)) if (pure.userEntityBlocked(rules, u)) return true
  for (const id of actorIds(item)) {
    const n = Number(id)
    if (Number.isFinite(n) && n > 0 && n <= 1e9 && pure.userEntityBlocked(rules, { id: n })) return true
  }
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

function flatten(value) {
  const text = String(value).replace(/<[^>]{1,80}>/g, '').replace(/\s+/g, ' ').trim()
  return text.length > 120 ? text.slice(0, 120) + '…' : text
}

// 实测：私信的 content 是字符串，站内消息的 content 是 { text: "..." }，
// 另外 link.title 带着"哪一条被改了"这类可读文本
function bodyOf(item) {
  const content = item && item.content
  if (typeof content === 'string' && content.trim()) return flatten(content)
  if (content && typeof content === 'object') {
    for (const key of ['text', 'content', 'body', 'title']) {
      const v = content[key]
      if (typeof v === 'string' && v.trim()) return flatten(v)
    }
  }
  for (const key of ['title', 'subject', 'body', 'text', 'message']) {
    const v = item && item[key]
    if (typeof v === 'string' && v.trim()) return flatten(v)
  }
  const link = item && item.link
  if (link && typeof link === 'object' && typeof link.title === 'string' && link.title.trim()) return flatten(link.title)
  return ''
}

// 开关打开时：哪些会话该被标记已读。只处理「我收到的」且「发信人被屏蔽」的行，
// 返回要去 clear 的对方 uid（站点自己也是用这个 uid 调 /mails/conversations/{uid}）。
function blockedUnreadConversations(items, rules, myId) {
  const mine = Number(myId)
  const out = new Set()
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue
    if (Number.isFinite(mine) && Number(item.to) !== mine) continue
    if (item.status === 1) continue
    const sender = (item.fromUser && item.fromUser.id) || (item.user && item.user.id) || item.from || item.uid
    if (!Number.isFinite(Number(sender))) continue
    if (!pure.userEntityBlocked(rules, { id: Number(sender), username: item && item.fromUser && item.fromUser.username })) continue
    out.add(Number(sender))
  }
  return Array.from(out)
}

module.exports = { actorIds, actors, blockedUnreadConversations, bodyOf, idOf, itemsOf, keyOf, projectIdsOf, shouldSkip, titleOf }
