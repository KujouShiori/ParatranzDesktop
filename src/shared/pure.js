'use strict'

// 项目行的核心特征键。要求至少命中两个：文件行、词条行都只有零个，
// 而项目行动辄七八个，这样文件 id 撞上被屏蔽项目 id 时不会被误删。
const PROJECT_CORE_KEYS = [
  'source', 'dest', 'license', 'stats', 'privacy', 'isPrivate',
  'logo', 'game', 'activeLevel', 'translatableOnly'
]

// 出现任意一个就不是项目：这些是文件行 / 词条行 / 翻译记忆行独有的字段
const NON_PROJECT_KEYS = [
  'format', 'hash', 'folder', 'progress', 'key', 'term', 'translation',
  'original', 'values', 'variants', 'caseSensitive', 'match', 'note', 'pid'
]


// 站点用 uid / project 作为外键名，不是 userId / projectId
const USER_ID_FIELD = /^(user_?id|uid)$/i
const PROJECT_ID_FIELD = /^(project_?id|project)$/i

// 真实返回里发信人是 fromUser、收信人是 toUser（私信与站内消息都是），
// 而 from / to / uid 是数字用户 id。收信人不该让整行消失——那会连自己发出去的消息一起藏掉。
const SENDER_KEYS = new Set(['user', 'fromUser', 'author', 'creator', 'sender', 'reviewer', 'leader', 'owner'])
const RECIPIENT_KEYS = new Set(['toUser', 'targetUser'])
const AUTHOR_KEYS = new Set([...SENDER_KEYS, ...RECIPIENT_KEYS])

// apiPath 已去掉 /api 前缀，所以这里从 /projects 开始写
const USER_REMOVE_SCOPES = [
  /^\/projects\/\d+\/comments(\/|$)/,
  /^\/projects\/\d+\/issues(\/|$)/,
  /^\/projects\/\d+\/members(\/|$)/,
  /^\/projects\/\d+\/history(\/|$)/,
  /^\/projects\/\d+\/trash(\/|$)/,
  /^\/projects\/\d+\/scores(\/|$)/,
  /^\/projects\/\d+\/leaderboard(\/|$)/,
  /^\/projects\/\d+\/applications(\/|$)/,
  /^\/projects\/\d+\/announcements(\/|$)/,
  /^\/users\/\d+\/activities(\/|$)/,
  /^\/users\/leaderboard(\/|$)/,
  /^\/leaderboard(\/|$)/,
  // /mails 与 /messages 故意不进移除名单：整行删掉的话，未读角标就点不开、清不掉，
  // 屏蔽反而把通知栏卡死。这两处改为「保留行 + 脱名 + 藏正文」。
  /^\/broadcasts(\/|$)/,
  /^\/comments(\/|$)/,
  /^\/users\/online(\/|$)/
]

// 这些接口返回的是「我自己」或站点配置，改写会让页面误判登录态或丢配置
const NEVER_FILTER = [/^\/account(\/|$)/, /^\/users\/profiles(\/|$)/, /^\/config\//]

function isNeverFiltered(apiPath) {
  return !!apiPath && NEVER_FILTER.some((re) => re.test(apiPath))
}

function hardBlockBody(projectId) {
  return '{"message":"Project ' + Number(projectId) + ' does not exist"}'
}

const MASK_TEXT = '已屏蔽用户'
const HIDDEN_BODY = '内容已隐藏（来自被屏蔽用户）'

// 只处理正文类字段；词条的 term / translation / note 等数据一律不碰，
// 屏蔽用户不该改动项目内容本身。
function hideRowBody(row) {
  if (typeof row.content === 'string') row.content = HIDDEN_BODY
  else if (row.content && typeof row.content === 'object' && typeof row.content.text === 'string') row.content.text = HIDDEN_BODY
  if (typeof row.html === 'string') row.html = HIDDEN_BODY
  if (typeof row.text === 'string') row.text = HIDDEN_BODY
  return row
}

function normalizeRules(raw) {
  const rules = {
    projectIds: new Set(),
    userIds: new Set(),
    userNames: new Set(),
    revealProjects: new Set(),
    revealUsers: new Set(),
    revealAll: false
  }
  if (!raw) return rules
  for (const p of raw.projects || []) {
    const id = Number(p && p.id)
    if (Number.isFinite(id) && id > 0) rules.projectIds.add(id)
  }
  for (const u of raw.users || []) {
    if (!u) continue
    const id = Number(u.id)
    if (Number.isFinite(id) && id > 0) rules.userIds.add(id)
    const name = typeof u.username === 'string' ? u.username.trim().toLowerCase() : ''
    if (name) rules.userNames.add(name)
  }
  const reveal = raw.reveal || {}
  for (const id of reveal.projectIds || []) rules.revealProjects.add(Number(id))
  for (const key of reveal.userKeys || []) rules.revealUsers.add(String(key))
  rules.revealAll = !!reveal.all
  return rules
}

function projectBlocked(rules, id) {
  const n = Number(id)
  if (!Number.isFinite(n)) return false
  if (rules.revealAll || rules.revealProjects.has(n)) return false
  return rules.projectIds.has(n)
}

function userKeyOf(entity) {
  if (!entity || typeof entity !== 'object') return ''
  const id = Number(entity.id !== undefined ? entity.id : entity.userId)
  if (Number.isFinite(id) && id > 0) return 'id:' + id
  const name = typeof entity.username === 'string' ? entity.username.trim().toLowerCase() : ''
  return name ? 'name:' + name : ''
}

function userEntityBlocked(rules, entity) {
  if (!entity || typeof entity !== 'object') return false
  const id = Number(entity.id !== undefined ? entity.id : entity.userId)
  if (Number.isFinite(id) && (rules.revealAll || rules.revealUsers.has('id:' + id))) return false
  const name = typeof entity.username === 'string' ? entity.username.trim().toLowerCase() : ''
  if (name && (rules.revealAll || rules.revealUsers.has('name:' + name))) return false
  if (Number.isFinite(id) && rules.userIds.has(id)) return true
  if (name && rules.userNames.has(name)) return true
  return false
}

function userNameBlocked(rules, name) {
  if (typeof name !== 'string') return false
  const n = name.trim().toLowerCase()
  if (!n) return false
  if (rules.revealAll || rules.revealUsers.has('name:' + n)) return false
  return rules.userNames.has(n)
}

function isProjectEntity(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false
  if (!Number.isFinite(Number(o.id)) || typeof o.name !== 'string') return false
  for (const k of NON_PROJECT_KEYS) if (k in o) return false
  let core = 0
  for (const k of PROJECT_CORE_KEYS) if (k in o) core++
  return core >= 2
}

function isUserEntity(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false
  if (typeof o.username !== 'string') return false
  return Number.isFinite(Number(o.id)) || Number.isFinite(Number(o.userId))
}

function carriesBlockedProject(o, rules) {
  for (const k of Object.keys(o)) {
    if (!PROJECT_ID_FIELD.test(k)) continue
    const v = o[k]
    if ((typeof v === 'number' || typeof v === 'string') && projectBlocked(rules, v)) return v
    // 真实返回里项目引用常常是对象：{ id, name }
    if (v && typeof v === 'object' && Number.isFinite(Number(v.id)) && projectBlocked(rules, v.id)) return v.id
  }
  // 站内消息把所属项目放在 link.project 里
  const link = o.link
  if (link && typeof link === 'object') {
    const p = link.project
    if ((typeof p === 'number' || typeof p === 'string') && projectBlocked(rules, p)) return p
    if (p && typeof p === 'object' && projectBlocked(rules, p.id)) return p.id
  }
  return 0
}

// 用户 id 是小整数，而 history 一类接口的 from / to 是 1e12 量级的时间戳，
// 用取值范围区分比按字段名猜可靠
function userBlockedById(rules, id) {
  const n = Number(id)
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return false
  if (rules.revealAll || rules.revealUsers.has('id:' + n)) return false
  return rules.userIds.has(n)
}

function blockedUserInRow(row, rules) {
  for (const key of SENDER_KEYS) {
    const v = row[key]
    if (v && typeof v === 'object' && isUserEntity(v) && userEntityBlocked(rules, v)) return true
  }
  // messages 里有一种条目不带 fromUser，只有数字 from，这时只能按 id 拦
  for (const key of ['from', 'uid', 'userId', 'user_id']) {
    if (key in row && userBlockedById(rules, row[key])) return true
  }
  return false
}

function parseSiteUrl(href) {
  const out = { projectId: null, userId: null, apiPath: null, pagePath: null, foreign: false }
  if (typeof href !== 'string' || !href) return out
  let u
  try {
    u = new URL(href, 'https://paratranz.cn')
  } catch (e) {
    return out
  }
  // 相对地址按站内处理，站外地址一律不参与屏蔽判断
  if (u.hostname !== 'paratranz.cn' && !u.hostname.endsWith('.paratranz.cn')) {
    out.foreign = true
    return out
  }
  const path = u.pathname
  const api = /^\/api(\/.*)$/.exec(path)
  if (api) out.apiPath = api[1]
  else out.pagePath = path
  const m = /^\/api\/projects\/(\d+)(?:\/|$)/.exec(path) || /^\/projects\/(\d+)(?:\/|$)/.exec(path)
  if (m) out.projectId = Number(m[1])
  const u2 = /^\/api\/users\/(\d+)(?:\/|$)/.exec(path) || /^\/users\/(\d+)(?:\/|$)/.exec(path)
  if (u2) out.userId = Number(u2[1])
  return out
}

function urlTargetsBlockedProject(rules, href) {
  const info = parseSiteUrl(href)
  if (info.projectId !== null && projectBlocked(rules, info.projectId)) return info.projectId
  if (info.apiPath) {
    const m = /^\/projects\/(\d+)(?:\/|$)/.exec(info.apiPath)
    if (m && projectBlocked(rules, m[1])) return Number(m[1])
  }
  return 0
}

function isUserRemoveScope(apiPath) {
  if (!apiPath) return false
  return USER_REMOVE_SCOPES.some((re) => re.test(apiPath))
}

function maskUserEntity(u) {
  if (typeof u.username === 'string') u.username = MASK_TEXT
  if ('nickname' in u) u.nickname = MASK_TEXT
  if (typeof u.avatar === 'string') u.avatar = ''
  if ('bio' in u && typeof u.bio === 'string') u.bio = ''
  if ('aboutMe' in u && typeof u.aboutMe === 'string') u.aboutMe = ''
  if ('email' in u && typeof u.email === 'string') u.email = ''
  return u
}

const ENVELOPE_LIST_KEYS = ['results', 'data', 'items', 'list', 'rows', 'records']

function envelopeArrayKey(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return ''
  for (const key of ENVELOPE_LIST_KEYS) if (Array.isArray(node[key])) return key
  return ''
}

function filterJson(data, rules, urlInfo, stats) {
  const s = stats || { droppedProjects: 0, droppedUsers: 0, maskedUsers: 0 }
  const removeUsers = isUserRemoveScope(urlInfo && urlInfo.apiPath)
  const listKey = envelopeArrayKey(data)
  const before = listKey ? data[listKey].length : 0
  walk(data, 0)
  if (listKey) {
    const removed = before - data[listKey].length
    if (removed > 0) {
      if (typeof data.rowCount === 'number') data.rowCount = Math.max(0, data.rowCount - removed)
    }
  }
  return s

  function walk(node, depth) {
    if (depth > 24 || !node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const el = node[i]
        if (!el || typeof el !== 'object') continue
        if (isProjectEntity(el) && projectBlocked(rules, el.id)) {
          node.splice(i, 1)
          s.droppedProjects++
          continue
        }
        if (carriesBlockedProject(el, rules)) {
          node.splice(i, 1)
          s.droppedProjects++
          continue
        }
        if (isUserEntity(el) && userEntityBlocked(rules, el)) {
          if (removeUsers) {
            node.splice(i, 1)
            s.droppedUsers++
            continue
          }
          maskUserEntity(el)
          s.maskedUsers++
          continue
        }
        if (blockedUserInRow(el, rules)) {
          if (removeUsers) {
            node.splice(i, 1)
            s.droppedUsers++
            continue
          }
          hideRowBody(el)
          walk(el, depth + 1)
          continue
        }
        walk(el, depth + 1)
      }
      return
    }

    for (const key of Object.keys(node)) {
      const value = node[key]
      if (!value || typeof value !== 'object') {
        if (key === 'username' && typeof value === 'string' && userNameBlocked(rules, value)) {
          node[key] = MASK_TEXT
          if ('nickname' in node) node.nickname = MASK_TEXT
          if (typeof node.avatar === 'string') node.avatar = ''
          s.maskedUsers++
        }
        continue
      }
      if (isProjectEntity(value) && projectBlocked(rules, value.id)) {
        node[key] = null
        s.droppedProjects++
        continue
      }
      if (isUserEntity(value) && userEntityBlocked(rules, value)) {
        if (SENDER_KEYS.has(key)) {
          if (removeUsers) {
            node[key] = null
            s.droppedUsers++
          } else {
            maskUserEntity(value)
            s.maskedUsers++
          }
          continue
        }
        maskUserEntity(value)
        s.maskedUsers++
        continue
      }
      walk(value, depth + 1)
    }
  }
}

function buildRulesState(rules) {
  return {
    projectIds: Array.from(rules.projectIds),
    userIds: Array.from(rules.userIds),
    userNames: Array.from(rules.userNames),
    revealAll: rules.revealAll,
    revealProjectIds: Array.from(rules.revealProjects),
    revealUserKeys: Array.from(rules.revealUsers)
  }
}

module.exports = {
  AUTHOR_KEYS,
  SENDER_KEYS,
  RECIPIENT_KEYS,
  userBlockedById,
  MASK_TEXT,
  PROJECT_CORE_KEYS,
  NON_PROJECT_KEYS,
  USER_REMOVE_SCOPES,
  buildRulesState,
  carriesBlockedProject,
  filterJson,
  hardBlockBody,
  isNeverFiltered,
  isProjectEntity,
  isUserEntity,
  isUserRemoveScope,
  maskUserEntity,
  NEVER_FILTER,
  normalizeRules,
  parseSiteUrl,
  projectBlocked,
  urlTargetsBlockedProject,
  userEntityBlocked,
  userKeyOf,
  userNameBlocked
}
