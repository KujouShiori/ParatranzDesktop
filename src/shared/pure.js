'use strict'

const PROJECT_HINT_KEYS = [
  'source', 'dest', 'stats', 'license', 'isPrivate', 'desc',
  'translatableOnly', 'words', 'translated', 'reviewed', 'createDate', 'creatorId',
  'logo', 'game', 'privacy', 'stage', 'activeLevel'
]

const TERM_LIKE_KEYS = ['key', 'zh', 'ja', 'en', 'values', 'note', 'proof']

// 站点用 uid / project 作为外键名，不是 userId / projectId
const USER_ID_FIELD = /^(user_?id|uid)$/i
const PROJECT_ID_FIELD = /^(project_?id|project)$/i

const AUTHOR_KEYS = new Set(['user', 'from', 'author', 'creator', 'targetUser', 'reviewer', 'leader', 'owner'])

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
  /^\/mails(\/|$)/,
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
  let hints = 0
  for (const k of PROJECT_HINT_KEYS) if (k in o) hints++
  if (hints === 0) return false
  for (const k of TERM_LIKE_KEYS) if (k in o) return false
  return true
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
  }
  return 0
}

function blockedUserInRow(row, rules) {
  for (const key of AUTHOR_KEYS) {
    const v = row[key]
    if (v && typeof v === 'object' && isUserEntity(v) && userEntityBlocked(rules, v)) return true
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
  if (typeof u.aboutMe === 'string') u.aboutMe = ''
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
        if (AUTHOR_KEYS.has(key)) {
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
  MASK_TEXT,
  PROJECT_HINT_KEYS,
  TERM_LIKE_KEYS,
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
