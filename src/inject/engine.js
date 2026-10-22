'use strict'

// 注入到页面主世界的引擎。它会被 func.toString() 序列化后在主世界重建，因此必须自包含：
// 不 require 外部模块、不引用闭包外变量、不依赖 eval（站点哪天加 CSP 也不会崩）。
// 同一套判定逻辑在 src/shared/pure.js 里有一份，test/parity.js 负责盯着两边不分叉。
module.exports = function shieldEngine(config) {
  const w = config.win || globalThis
  const d = config.doc || w.document
  const MODE = config.mode || 'full'

  const MASK_TEXT = '已屏蔽用户'
  const PROJECT_CORE_KEYS = [
    'source', 'dest', 'license', 'stats', 'privacy', 'isPrivate',
    'logo', 'game', 'activeLevel', 'translatableOnly'
  ]
  const NON_PROJECT_KEYS = [
    'format', 'hash', 'folder', 'progress', 'key', 'term', 'translation',
    'original', 'values', 'variants', 'caseSensitive', 'match', 'note', 'pid'
  ]
  const USER_ID_FIELD = /^(user_?id|uid)$/i
  const PROJECT_ID_FIELD = /^(project_?id|project)$/i
  const AUTHOR_KEYS = ['user', 'from', 'author', 'creator', 'targetUser', 'reviewer', 'leader', 'owner']
  const ENVELOPE_LIST_KEYS = ['results', 'data', 'items', 'list', 'rows', 'records']
  // 在这些接口里，屏蔽用户等于「整条消失」；其它接口（词条、译文）只脱名，绝不能少数据
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
  const MAX_FILTER_BYTES = 4 * 1024 * 1024
  const HIDE_ATTR = 'data-pt-shielded'
  // 列表项容器：全部来自站点编译产物里未被混淆的 class 名，data-v-* 每次部署都变，不能用
  const ITEM_CONTAINERS = ['.project', '.item', '.user-link', '.comment-item', '.mail-item', '.broadcast', '.message', '.cv-item', 'li', 'tr', '.string']
  // 这两个接口返回「我自己」，改写它会让站点误判登录状态
  const NEVER_FILTER = [/^\/account(\/|$)/, /^\/users\/profiles\/my(\/|$)/, /^\/config\//]

  let rules = buildRules(config.rules)
  let observer = null
  let routeTick = null
  let wallEl = null
  let fabEl = null
  const stats = { filtered: 0, droppedProjects: 0, droppedUsers: 0, maskedUsers: 0, hardBlocked: 0, domHidden: 0 }

  function buildRules(state) {
    const r = {
      projectIds: new Set((state && state.projectIds) || []),
      userIds: new Set((state && state.userIds) || []),
      userNames: new Set((state && state.userNames) || []),
      revealProjects: new Set((state && state.revealProjectIds) || []),
      revealUsers: new Set((state && state.revealUserKeys) || []),
      revealAll: !!(state && state.revealAll)
    }
    r.empty = !r.projectIds.size && !r.userIds.size && !r.userNames.size
    return r
  }

  function projectBlocked(id) {
    const n = Number(id)
    if (!Number.isFinite(n)) return false
    if (rules.revealAll || rules.revealProjects.has(n)) return false
    return rules.projectIds.has(n)
  }

  function userEntityBlocked(entity) {
    if (!entity || typeof entity !== 'object') return false
    const id = Number(entity.id !== undefined ? entity.id : entity.userId)
    if (Number.isFinite(id) && (rules.revealAll || rules.revealUsers.has('id:' + id))) return false
    const name = typeof entity.username === 'string' ? entity.username.trim().toLowerCase() : ''
    if (name && (rules.revealAll || rules.revealUsers.has('name:' + name))) return false
    if (Number.isFinite(id) && rules.userIds.has(id)) return true
    return !!(name && rules.userNames.has(name))
  }

  function userNameBlocked(name) {
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

  function carriesBlockedProject(o) {
    for (const k of Object.keys(o)) {
      if (!PROJECT_ID_FIELD.test(k)) continue
      const v = o[k]
      if ((typeof v === 'number' || typeof v === 'string') && projectBlocked(v)) return true
      if (v && typeof v === 'object' && Number.isFinite(Number(v.id)) && projectBlocked(v.id)) return true
    }
    return false
  }

  function blockedUserInRow(row) {
    for (const key of AUTHOR_KEYS) {
      const v = row[key]
      if (v && typeof v === 'object' && isUserEntity(v) && userEntityBlocked(v)) return true
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

  function envelopeArrayKey(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return ''
    for (const key of ENVELOPE_LIST_KEYS) if (Array.isArray(node[key])) return key
    return ''
  }

  function filterJson(data, urlInfo) {
    const removeUsers = isUserRemoveScope(urlInfo && urlInfo.apiPath)
    const listKey = envelopeArrayKey(data)
    const before = listKey ? data[listKey].length : 0
    walk(data, 0)
    if (listKey) {
      const removed = before - data[listKey].length
      if (removed > 0 && typeof data.rowCount === 'number') data.rowCount = Math.max(0, data.rowCount - removed)
    }

    function walk(node, depth) {
      if (depth > 24 || !node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) {
          const el = node[i]
          if (!el || typeof el !== 'object') continue
          if (isProjectEntity(el) && projectBlocked(el.id)) {
            node.splice(i, 1)
            stats.droppedProjects++
            continue
          }
          if (carriesBlockedProject(el)) {
            node.splice(i, 1)
            stats.droppedProjects++
            continue
          }
          if (isUserEntity(el) && userEntityBlocked(el)) {
            if (removeUsers) {
              node.splice(i, 1)
              stats.droppedUsers++
              continue
            }
            maskUserEntity(el)
            stats.maskedUsers++
            continue
          }
          if (blockedUserInRow(el)) {
            if (removeUsers) {
              node.splice(i, 1)
              stats.droppedUsers++
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
          if (key === 'username' && typeof value === 'string' && userNameBlocked(value)) {
            node[key] = MASK_TEXT
            if ('nickname' in node) node.nickname = MASK_TEXT
            if (typeof node.avatar === 'string') node.avatar = ''
            stats.maskedUsers++
          }
          continue
        }
        if (isProjectEntity(value) && projectBlocked(value.id)) {
          node[key] = null
          stats.droppedProjects++
          continue
        }
        if (isUserEntity(value) && userEntityBlocked(value)) {
          if (AUTHOR_KEYS.indexOf(key) >= 0) {
            if (removeUsers) {
              node[key] = null
              stats.droppedUsers++
            } else {
              maskUserEntity(value)
              stats.maskedUsers++
            }
            continue
          }
          maskUserEntity(value)
          stats.maskedUsers++
          continue
        }
        walk(value, depth + 1)
      }
    }
  }

  function classifyRequest(rawUrl) {
    const info = parseSiteUrl(rawUrl)
    if (info.foreign || !info.apiPath) return { info: info, action: 'passthrough' }
    if (/socket\.io|engine\.io/.test(info.apiPath)) return { info: info, action: 'passthrough' }
    if (NEVER_FILTER.some((re) => re.test(info.apiPath))) return { info: info, action: 'passthrough' }
    if (rules.empty) return { info: info, action: 'passthrough' }
    if (info.projectId !== null && projectBlocked(info.projectId)) {
      return { info: info, action: 'hardblock', projectId: info.projectId }
    }
    return { info: info, action: 'filter' }
  }

  function shouldFilterUrl(rawUrl) {
    return classifyRequest(rawUrl).action === 'filter'
  }

  function filterText(raw, url) {
    if (!raw) return raw
    if (raw.length > MAX_FILTER_BYTES) return raw
    let data
    try {
      data = JSON.parse(raw)
    } catch (e) {
      return raw
    }
    stats.filtered++
    filterJson(data, parseSiteUrl(url))
    const after = JSON.stringify(data)
    return after
  }

  // 与站点自己的 404 契约保持一致，页面会走它原有的「项目不存在」分支而不是报网络错误
  function hardBlockBody(projectId) {
    return '{"message":"Project ' + Number(projectId) + ' does not exist"}'
  }

  function parseBlockedJson(projectId) {
    try {
      return JSON.parse(hardBlockBody(projectId))
    } catch (e) {
      return null
    }
  }

  // ---------- XMLHttpRequest ----------
  function installXhr() {
    const RealXHR = w.XMLHttpRequest
    if (!RealXHR || RealXHR.prototype.__ptShieldPatched) return
    RealXHR.prototype.__ptShieldPatched = true

    const nativeOpen = RealXHR.prototype.open
    const nativeSend = RealXHR.prototype.send
    const nativeAllHeaders = RealXHR.prototype.getAllResponseHeaders
    const nativeHeader = RealXHR.prototype.getResponseHeader
    const proto = RealXHR.prototype
    const g = function (name) {
      const dd = Object.getOwnPropertyDescriptor(proto, name)
      return dd && dd.get ? dd.get : null
    }
    const getText = g('responseText')
    const getResp = g('response')
    const getStatus = g('status')
    const getStatusText = g('statusText')
    const getReady = g('readyState')

    function PatchedXHR() {
      const xhr = new RealXHR()
      const pt = { url: '', fake: false, blockedId: 0, cacheRaw: null, cacheOut: null }
      xhr.__pt = pt

      function shadow(name, value) {
        try {
          Object.defineProperty(xhr, name, { configurable: true, writable: true, value: value })
        } catch (e) {}
      }

      // 假响应直接给固定值；真响应先取原值，再按需过滤（同一份原文只过滤一次）
      function readable(name, getter, fakeValue, transform) {
        try {
          Object.defineProperty(xhr, name, {
            configurable: true,
            get: function () {
              const fake = typeof fakeValue === 'function' ? fakeValue() : fakeValue
              if (pt.fake) return fake
              const raw = getter ? getter.call(xhr) : fake
              if (!transform) return raw
              if (xhr.readyState < 4) return raw
              if (pt.cacheRaw === raw) return pt.cacheOut
              const out = transform(raw)
              pt.cacheRaw = raw
              pt.cacheOut = out
              return out
            }
          })
        } catch (e) {}
      }

      function filterBody(raw) {
        if (typeof raw !== 'string' || !shouldFilterUrl(pt.url)) return raw
        try {
          return filterText(raw, pt.url)
        } catch (e) {
          return raw
        }
      }

      function filterObject(value) {
        if (!value || typeof value !== 'object' || !shouldFilterUrl(pt.url)) return value
        try {
          filterJson(value, parseSiteUrl(pt.url))
        } catch (e) {}
        return value
      }

      shadow('open', function (method, url) {
        pt.url = typeof url === 'string' ? url : String(url)
        return nativeOpen.apply(xhr, arguments)
      })

      shadow('send', function () {
        const cls = classifyRequest(pt.url)
        if (cls.action !== 'hardblock') return nativeSend.apply(xhr, arguments)
        stats.hardBlocked++
        pt.fake = true
        pt.blockedId = cls.projectId
        setTimeout(function () {
          fire('readystatechange')
          fire('load')
          fire('loadend')
        }, 0)
        return undefined
      })

      function fire(type) {
        let ev = null
        try { ev = new w.Event(type) } catch (e) {}
        const handler = xhr['on' + type]
        if (typeof handler === 'function') {
          try { handler.call(xhr, ev) } catch (e) {}
        }
        try { xhr.dispatchEvent(ev) } catch (e) {}
      }

      readable('readyState', getReady, 4)
      readable('status', getStatus, 404)
      readable('statusText', getStatusText, 'Not Found')
      readable('responseText', getText, () => hardBlockBody(pt.blockedId), filterBody)
      readable('response', getResp, () => (xhr.responseType === 'json'
        ? parseBlockedJson(pt.blockedId)
        : hardBlockBody(pt.blockedId)), function (raw) {
        return xhr.responseType === 'json' ? filterObject(raw) : filterBody(raw)
      })

      shadow('getAllResponseHeaders', function () {
        if (pt.fake) return 'content-type: application/json\r\n'
        return nativeAllHeaders.apply(xhr, arguments)
      })
      shadow('getResponseHeader', function (name) {
        if (pt.fake && String(name).toLowerCase() === 'content-type') return 'application/json; charset=utf-8'
        return nativeHeader.apply(xhr, arguments)
      })
      return xhr
    }

    PatchedXHR.prototype = RealXHR.prototype
    for (const k of ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE']) PatchedXHR[k] = RealXHR[k]
    try {
      Object.defineProperty(w, 'XMLHttpRequest', { configurable: true, writable: true, value: PatchedXHR })
    } catch (e) {
      w.XMLHttpRequest = PatchedXHR
    }
  }

  // ---------- fetch ----------
  function installFetch() {
    if (typeof w.fetch !== 'function' || w.fetch.__ptShieldPatched) return
    const native = w.fetch
    const patched = function (input, init) {
      let url = ''
      try {
        url = typeof input === 'string' ? input : input && input.url ? input.url : String(input)
      } catch (e) {
        url = ''
      }
      const action = classifyRequest(url)
      if (action.action === 'hardblock') {
        stats.hardBlocked++
        return w.Promise.resolve(new w.Response(hardBlockBody(action.projectId), {
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-type': 'application/json; charset=utf-8' }
        }))
      }
      const p = native.call(w, input, init)
      if (action.action !== 'filter') return p
      return p.then(function (res) {
        const ct = (res.headers && res.headers.get('content-type')) || ''
        if (!/json/i.test(ct)) return res
        return res.clone().text().then(function (text) {
          let out
          try {
            out = filterText(text, url)
          } catch (e) {
            return res
          }
          if (out === text) return res
          const next = new w.Response(out, { status: res.status, statusText: res.statusText, headers: res.headers })
          try {
            Object.defineProperty(next, 'url', { configurable: true, value: res.url })
          } catch (e) {}
          return next
        }, function () { return res })
      })
    }
    patched.__ptShieldPatched = true
    w.fetch = patched
  }

  // ---------- WebSocket 旁听 ----------
  // 站点的私信和消息是 socket.io 推的（轮询通道被站点拒了，只有 WS）。
  // 关键：dom-ready 兜底注入时，站点的 socket 往往已经连上了，改 window.WebSocket 构造器
  // 对既有连接完全无效。所以钩子必须打在原型上——onmessage 赋值和 addEventListener 两条路
  // 都盖住，已经建立的连接往后的帧也照样能旁听。
  const nowMs = typeof config.now === 'function' ? config.now : () => Date.now()
  const ACTIVITY_EVENTS = /"(mail|message|messages|newMessage|newMail|broadcast|notify|notification)"/
  const ACTIVITY_PREFIX = /^(42|40)\[/
  let activityLastFire = 0

  function observeSocketFrame(data) {
    try {
      if (typeof data !== 'string' || !data) return
      if (!ACTIVITY_PREFIX.test(data)) return
      if (!ACTIVITY_EVENTS.test(data)) return
      const now = nowMs()
      // 合并是故意的：一次触发会把这个账号的所有源都拉一遍，连发只是重复请求
      if (now - activityLastFire < 800) return
      activityLastFire = now
      sendIntent('activity', { source: 'socket' })
    } catch (e) {}
  }

  function installWebSocketWatch() {
    const RealWS = w.WebSocket
    const proto = RealWS && RealWS.prototype
    if (!proto || proto.__ptShieldWatched) return
    proto.__ptShieldWatched = true

    try {
      const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage')
      if (desc && typeof desc.set === 'function') {
        Object.defineProperty(proto, 'onmessage', {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set: function (handler) {
            const self = this
            const wrapped = typeof handler === 'function'
              ? function (ev) { observeSocketFrame(ev && ev.data); return handler.apply(self, arguments) }
              : handler
            return desc.set.call(self, wrapped)
          }
        })
      }
    } catch (e) {}

    try {
      const nativeAdd = proto.addEventListener
      if (typeof nativeAdd === 'function') {
        proto.addEventListener = function (type, listener, options) {
          const self = this
          if (type === 'message' && typeof listener === 'function') {
            return nativeAdd.call(this, type, function (ev) {
              observeSocketFrame(ev && ev.data)
              return listener.apply(self, arguments)
            }, options)
          }
          return nativeAdd.apply(this, arguments)
        }
      }
    } catch (e) {}
  }

  // ---------- DOM ----------
  function itemOf(anchor) {
    for (const sel of ITEM_CONTAINERS) {
      if (anchor.closest) {
        const hit = anchor.closest(sel)
        if (hit) return hit
      }
    }
    let node = anchor
    let hops = 0
    while (node && node !== d.body && hops < 6) {
      const parent = node.parentElement
      if (!parent) return node
      if (parent.children && parent.children.length > 1) return node
      node = parent
      hops++
    }
    return node
  }

  function hideItem(el, kind) {
    if (!el || !el.setAttribute || el.getAttribute(HIDE_ATTR) === kind) return
    el.setAttribute(HIDE_ATTR, kind)
    stats.domHidden++
  }

  function queryAll(root, sel) {
    try {
      return root.querySelectorAll(sel)
    } catch (e) {
      return []
    }
  }

  function passDom(root) {
    if (MODE === 'filter-only' || rules.empty || !root || !root.querySelectorAll) return
    for (const sel of ['a[href*="/projects/"]', 'a[href*="/users/"]']) {
      for (const el of queryAll(root, sel)) {
        const href = el.getAttribute('href')
        if (!href) continue
        const info = parseSiteUrl(href)
        const item = itemOf(el)
        if (info.projectId !== null && projectBlocked(info.projectId)) hideItem(item, 'project')
        else if (info.userId !== null && rules.userIds.has(info.userId) &&
          !rules.revealAll && !rules.revealUsers.has('id:' + info.userId)) hideItem(item, 'user')
      }
    }
    if (rules.userNames.size) {
      for (const el of queryAll(root, '[alt]')) {
        if (userNameBlocked(el.getAttribute('alt'))) el.style.visibility = 'hidden'
      }
    }
  }

  const STYLE_TEXT = [
    '[' + HIDE_ATTR + '] { display: none !important; }',
    '.pt-shield-fab { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;',
    ' background:#1f1f1f; color:#fff; border:1px solid #555; border-radius:6px;',
    ' padding:8px 12px; font-size:13px; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,.4); }',
    '.pt-shield-fab:hover { background:#3a3a3a; }',
    '.pt-shield-wall { position: fixed; left:0; top:0; right:0; bottom:0; z-index: 2147483600;',
    ' background:#161616; color:#eee; display:flex; align-items:center; justify-content:center;',
    ' text-align:center; font-size:15px; }',
    '.pt-shield-wall > div { max-width: 30rem; line-height: 2; }',
    '.pt-shield-wall button { margin: 0 6px; padding: 6px 16px; cursor: pointer; }'
  ].join('\n')

  function injectStyle() {
    if (!d.head || d.getElementById('pt-shield-style')) return
    const s = d.createElement('style')
    s.id = 'pt-shield-style'
    s.textContent = STYLE_TEXT
    d.head.appendChild(s)
  }

  // ---------- 屏蔽墙 / 快捷按钮 ----------
  function currentPageHit() {
    const info = parseSiteUrl(w.location.href)
    if (info.projectId !== null && projectBlocked(info.projectId)) return { kind: 'project', id: info.projectId }
    if (info.userId !== null && rules.userIds.has(info.userId) &&
      !rules.revealAll && !rules.revealUsers.has('id:' + info.userId)) return { kind: 'user', id: info.userId }
    return null
  }

  // 页面脚本能监听 postMessage，所以这条方向只当作「请求」，主进程一律要用户在自己的窗口里点确认。
  function sendIntent(type, payload, clickEvent) {
    if (clickEvent && clickEvent.isTrusted === false) return
    try {
      w.postMessage({ channel: 'pt-shield-intent', type: type, payload: payload }, w.location.origin)
    } catch (e) {}
  }

  function removeWall() {
    if (wallEl && wallEl.parentNode) wallEl.parentNode.removeChild(wallEl)
    wallEl = null
  }

  function showWall(hit) {
    if (wallEl && wallEl.getAttribute('data-hit') === hit.kind + ':' + hit.id) return
    removeWall()
    const label = hit.kind === 'project' ? '项目' : '用户'
    wallEl = d.createElement('div')
    wallEl.className = 'pt-shield-wall'
    wallEl.setAttribute('data-hit', hit.kind + ':' + hit.id)
    const box = d.createElement('div')
    box.appendChild(d.createTextNode(label + ' ' + hit.id + ' 已被本客户端屏蔽。'))
    box.appendChild(d.createElement('br'))
    const reveal = d.createElement('button')
    reveal.textContent = '临时显示'
    reveal.addEventListener('click', function (ev) {
      sendIntent('reveal', hit, ev)
      removeWall()
    }, true)
    const back = d.createElement('button')
    back.textContent = '返回'
    back.addEventListener('click', function (ev) {
      if (ev && ev.isTrusted === false) return
      if (w.history && w.history.length > 1) w.history.back()
      else w.location.href = '/'
    }, true)
    box.appendChild(reveal)
    box.appendChild(back)
    wallEl.appendChild(box)
    ;(d.body || d.documentElement).appendChild(wallEl)
  }

  function updateFab() {
    if (MODE === 'filter-only' || !d.body) return
    const info = parseSiteUrl(w.location.href)
    let target = null
    if (info.projectId !== null && !projectBlocked(info.projectId)) target = { kind: 'project', id: info.projectId }
    else if (info.userId !== null) target = { kind: 'user', id: info.userId }
    const wanted = target ? target.kind + ':' + target.id : ''
    if (fabEl && fabEl.getAttribute('data-target') !== wanted) {
      if (fabEl.parentNode) fabEl.parentNode.removeChild(fabEl)
      fabEl = null
    }
    if (!target || fabEl) return
    fabEl = d.createElement('button')
    fabEl.className = 'pt-shield-fab'
    fabEl.setAttribute('data-target', wanted)
    fabEl.textContent = target.kind === 'project' ? '屏蔽本项目 ' + target.id : '屏蔽此用户 ' + target.id
    fabEl.addEventListener('click', function (ev) {
      sendIntent('block', {
        kind: target.kind,
        id: target.id,
        title: (d.title || '').trim(),
        url: w.location.href
      }, ev)
    }, true)
    d.body.appendChild(fabEl)
  }

  function checkRoute() {
    injectStyle()
    const hit = rules.empty ? null : currentPageHit()
    if (hit) showWall(hit)
    else removeWall()
    updateFab()
    passDom(d)
  }

  function schedule() {
    if (routeTick) return
    routeTick = setTimeout(function () {
      routeTick = null
      checkRoute()
    }, 0)
  }

  function installRouter() {
    if (!w.history || w.history.__ptShieldPatched) return
    const push = w.history.pushState
    const replace = w.history.replaceState
    w.history.pushState = function () {
      const r = push.apply(w.history, arguments)
      schedule()
      return r
    }
    w.history.replaceState = function () {
      const r = replace.apply(w.history, arguments)
      schedule()
      return r
    }
    w.history.__ptShieldPatched = true
    w.addEventListener('popstate', schedule)
    w.addEventListener('hashchange', schedule)
    w.addEventListener('load', function () { installObserver(); schedule() })
    if (d.addEventListener) {
      d.addEventListener('DOMContentLoaded', function () { installObserver(); schedule() })
    }
  }

  function installObserver() {
    if (MODE === 'filter-only' || !d.body) return
    if (observer) observer.disconnect()
    observer = null
    if (rules.empty || !w.MutationObserver) return
    observer = new w.MutationObserver(function (records) {
      for (const r of records) {
        for (const n of r.addedNodes) if (n && n.nodeType === 1) passDom(n)
      }
    })
    observer.observe(d.body, { childList: true, subtree: true })
  }

  // 站点把项目名缓存在 sessionStorage['project.name.<id>']、收藏缓存在 localStorage['starred:<uid>']，
  // 网络层屏蔽之后这些缓存仍会让名字回流，所以改名/删除时必须一起清掉。
  function purgeCaches() {
    if (MODE === 'filter-only') return
    try {
      const ss = w.sessionStorage
      for (let i = ss.length - 1; i >= 0; i--) {
        const key = ss.key(i)
        const m = key && /^project\.name\.(\d+)$/.exec(key)
        if (m && projectBlocked(m[1])) ss.removeItem(key)
      }
      const ls = w.localStorage
      for (let i = ls.length - 1; i >= 0; i--) {
        const key = ls.key(i)
        if (!key || key.indexOf('starred:') !== 0) continue
        let parsed
        try {
          parsed = JSON.parse(ls.getItem(key))
        } catch (e) {
          continue
        }
        const cleaned = stripBlocked(parsed)
        if (JSON.stringify(cleaned) !== JSON.stringify(parsed)) ls.setItem(key, JSON.stringify(cleaned))
      }
    } catch (e) {}
  }

  function stripBlocked(value) {
    if (Array.isArray(value)) {
      return value.filter((v) => !(Number(v) && projectBlocked(v)) && !(v && typeof v === 'object' && (projectBlocked(v.id) || projectBlocked(v))))
    }
    if (value && typeof value === 'object') {
      const out = {}
      for (const k of Object.keys(value)) {
        if (projectBlocked(k) || projectBlocked(value[k])) continue
        out[k] = value[k]
      }
      return out
    }
    if (Number(value) && projectBlocked(value)) return null
    return value
  }

  // 名单更新只能走这条句柄：token 只存在于参数和闭包里，不会出现在页面能监听的任何消息里。
  function applyRules(state, token) {
    if (config.token && token !== config.token) return false
    rules = buildRules(state)
    if (observer) {
      observer.disconnect()
      observer = null
    }
    const marked = d.querySelectorAll ? queryAll(d, '[' + HIDE_ATTR + ']') : []
    for (const el of marked) el.removeAttribute(HIDE_ATTR)
    purgeCaches()
    installObserver()
    checkRoute()
    return true
  }

  if (config.handleName) {
    try {
      Object.defineProperty(w, config.handleName, { configurable: true, value: applyRules })
    } catch (e) {
      w[config.handleName] = applyRules
    }
    // 只读诊断出口，供 selftest 和 DevTools 查看。知道句柄名字不够，改名单仍需要 token。
    w.__ptShieldHandle = config.handleName
    w.__ptShieldInfo = function () {
      return {
        version: 1,
        mode: MODE,
        empty: rules.empty,
        patchedFetch: !!(w.fetch && w.fetch.__ptShieldPatched),
        patchedXhr: !!(w.XMLHttpRequest && w.XMLHttpRequest.prototype && w.XMLHttpRequest.prototype.__ptShieldPatched),
        projects: Array.from(rules.projectIds),
        users: Array.from(rules.userIds),
        revealAll: rules.revealAll,
        stats: stats
      }
    }
  }

  installXhr()
  installFetch()
  if (MODE !== 'filter-only') {
    installWebSocketWatch()
    injectStyle()
    installRouter()
    installObserver()
    checkRoute()
  }

  return {
    ok: true,
    engineVersion: 1,
    mode: MODE,
    empty: rules.empty,
    stats: stats
  }
}
