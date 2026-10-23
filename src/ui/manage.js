'use strict'

const $ = (id) => document.getElementById(id)
let snap = null

function status(text, isError) {
  const el = $('status')
  el.textContent = text
  el.className = isError ? 'err' : ''
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = '' }, 4000)
}

// 解除之后会发生什么：被屏蔽引擎改写过的页面会自动重新加载一次；
// 页面上有没写完的字时不替你刷，改成给一条带按钮的提示。
function unblockHint() {
  status('已解除；被改写过的那几页会自动重新加载，有没写完的字时会在页面底部提示你手动刷')
}

function time(v) {
  if (!v) return ''
  return new Date(v).toLocaleString('zh-CN', { hour12: false })
}

function userKey(u) {
  return u.id ? 'id:' + u.id : 'name:' + String(u.username || '').toLowerCase()
}

function isRevealed(kind, key) {
  if (!snap) return false
  if (snap.reveal.all) return true
  if (kind === 'project') return snap.reveal.projectIds.includes(Number(key))
  return snap.reveal.userKeys.includes(key)
}

function renderProjects() {
  const tbody = $('projectTable').querySelector('tbody')
  tbody.textContent = ''
  const list = (snap && snap.blocklist.projects) || []
  $('projectEmpty').classList.toggle('hidden', list.length > 0)
  for (const p of list) {
    const tr = document.createElement('tr')
    if (isRevealed('project', p.id)) tr.className = 'revealed'
    const name = td('name')
    if (p.url) {
      const a = document.createElement('a')
      a.href = '#'
      a.textContent = p.name || ('项目 ' + p.id)
      a.addEventListener('click', (e) => { e.preventDefault(); api.openSite({ url: p.url }) })
      name.appendChild(a)
    } else {
      name.textContent = p.name || ('项目 ' + p.id)
    }
    tr.appendChild(name)
    tr.appendChild(td(String(p.id)))
    tr.appendChild(td(time(p.addedAt)))
    const ops = td('ops')
    ops.appendChild(button(isRevealed('project', p.id) ? '已临时显示' : '临时显示', 'ghost', () => api.revealProject(p.id).then(apply).then(unblockHint)))
    ops.appendChild(button('删除', 'ghost', () => api.removeProject(p.id).then(unblockHint)))
    tr.appendChild(ops)
    tbody.appendChild(tr)
  }
}

function renderUsers() {
  const tbody = $('userTable').querySelector('tbody')
  tbody.textContent = ''
  const list = (snap && snap.blocklist.users) || []
  $('userEmpty').classList.toggle('hidden', list.length > 0)
  for (const u of list) {
    const tr = document.createElement('tr')
    const key = userKey(u)
    if (isRevealed('user', key)) tr.className = 'revealed'
    tr.appendChild(td(u.username || '(仅按 ID 屏蔽)', 'name'))
    tr.appendChild(td(String(u.id || '')))
    tr.appendChild(td(time(u.addedAt)))
    const ops = td('ops')
    ops.appendChild(button(isRevealed('user', key) ? '已临时显示' : '临时显示', 'ghost', () => api.revealUser(key).then(apply).then(unblockHint)))
    ops.appendChild(button('删除', 'ghost', () => api.removeUser(key).then(unblockHint)))
    tr.appendChild(ops)
    tbody.appendChild(tr)
  }
}

function renderAccounts() {
  const ul = $('accountList')
  ul.textContent = ''
  const list = (snap && snap.accounts) || []
  if (!list.length) {
    const li = document.createElement('li')
    li.textContent = '当前只有默认窗口。新增账号后可以同时登录多个账号并行翻译。'
    li.className = 'empty'
    ul.appendChild(li)
  }
  for (const a of list) {
    const li = document.createElement('li')
    const input = document.createElement('input')
    input.type = 'text'
    input.value = a.name
    input.addEventListener('change', () => api.accountRename({ id: a.id, name: input.value }))
    li.appendChild(input)
    li.appendChild(button('打开窗口', '', () => api.openSite({ account: a.id })))
    li.appendChild(button('删除', 'ghost', () => {
      if (!confirm('删除账号「' + a.name + '」？该账号的登录状态会一并清除。')) return
      api.accountRemove(a.id)
    }))
    ul.appendChild(li)
  }
}

function renderSettings() {
  const s = (snap && snap.settings) || {}
  $('revealAll').checked = !!(snap && snap.reveal && snap.reveal.all)
  $('notifyOn').checked = s.notifications !== false
  $('notifyInterval').value = String(s.notifyIntervalSec || 45)
  $('closeToTray').checked = s.closeToTray !== false
  $('fabOn').checked = s.showPageFab !== false
  $('autoClearMail').checked = s.autoClearBlockedMail === true
  $('dumpShapes').checked = !!s.dumpShapes
}

function renderPlugins() {
  return api.plugins().then((list) => {
    const tbody = $('pluginTable').querySelector('tbody')
    tbody.textContent = ''
    $('pluginEmpty').classList.toggle('hidden', list.length > 0)
    for (const p of list) {
      const tr = document.createElement('tr')
      tr.appendChild(td(p.name, 'name'))
      tr.appendChild(td(p.kind === 'css' ? '样式' : '脚本'))
      tr.appendChild(td((p.matches || []).join(' ') || '全部页面'))
      tr.appendChild(td(Math.round(p.bytes / 102.4) / 10 + ' KB'))
      const box = document.createElement('td')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = p.enabled
      cb.addEventListener('change', () => api.togglePlugin({ file: p.file, enabled: cb.checked }).then(refreshPluginHint))
      box.appendChild(cb)
      tr.appendChild(box)
      tbody.appendChild(tr)
    }
    refreshPluginHint()
  })
}

function refreshPluginHint() {
  $('pluginHint').textContent = '插件文件夹里的改动要重载窗口才生效'
}

function accountLabel(account) {
  if (!account || account === 'default') return '默认窗口'
  const a = ((snap && snap.accounts) || []).find((x) => x.id === account)
  return (a && a.name) || account
}

// 站点标题形如「术语 - 某项目 - ParaTranz」，提示里不需要那个尾巴
function pageTitleOf(t) {
  const stripped = String(t.title || '').replace(/\s*[-–]\s*ParaTranz\s*$/i, '').trim()
  return stripped || t.url
}

function renderTarget() {
  const btn = $('blockCurrent')
  const hint = $('blockCurrentHint')
  if (!btn || !hint) return Promise.resolve()
  return api.currentTarget().then((t) => {
    if (!t) {
      btn.disabled = true
      btn.textContent = '屏蔽当前页面'
      hint.textContent = '站点窗口当前不在项目页或用户页上'
      return
    }
    btn.disabled = false
    btn.textContent = (t.kind === 'project' ? '屏蔽本项目 ' : '屏蔽此用户 ') + t.id
    hint.textContent = accountLabel(t.account) + '：' + pageTitleOf(t)
  })
}

function apply(next) {
  if (next) snap = next
  renderProjects()
  renderUsers()
  renderAccounts()
  renderSettings()
  renderLoginAccounts()
  renderPlugins()
  renderTarget()
}

function td(text, cls) {
  const el = document.createElement('td')
  el.textContent = text == null ? '' : String(text)
  if (cls) el.className = cls
  return el
}

function button(label, cls, onClick) {
  const b = document.createElement('button')
  b.textContent = label
  if (cls) b.className = cls
  b.addEventListener('click', onClick)
  return b
}

const api = window.ptManage

function renderLoginAccounts() {
  const sel = $('loginAccount')
  if (!sel) return
  const list = [{ id: 'default', name: '默认窗口' }].concat((snap && snap.accounts) || [])
  const previous = sel.value
  sel.textContent = ''
  for (const a of list) {
    const opt = document.createElement('option')
    opt.value = a.id
    opt.textContent = a.name || a.id
    sel.appendChild(opt)
  }
  if (previous) sel.value = previous
  api.whoami(sel.value).then((who) => {
    $('loginState').textContent = who.logged ? ('已登录：' + (who.nickname || who.username)) : '未登录'
    $('loginState').className = who.logged ? '' : 'empty'
  })
}

function wire() {
  $('blockCurrent').addEventListener('click', () => api.blockCurrent().then(apply).then(renderTarget))
  // 他是先在站点窗口翻到那一页、再切回这个窗口的，所以聚焦时重新读一次当前页面
  window.addEventListener('focus', renderTarget)
  $('revealAll').addEventListener('change', (e) => api.setRevealAll(e.target.checked).then(apply).then(() => { if (e.target.checked) unblockHint() }))
  $('addProject').addEventListener('click', () => {
    const id = Number($('projectId').value.trim())
    if (!Number.isFinite(id) || id <= 0) return status('请输入数字项目 ID', true)
    const res = api.addProject({ id: id, name: $('projectName').value.trim() })
    Promise.resolve(res).then((r) => {
      if (r && !r.ok) status(r.error, true)
      else { $('projectId').value = ''; $('projectName').value = ''; status('已加入屏蔽名单') }
    })
  })
  $('addUser').addEventListener('click', () => {
    const id = Number($('userId').value.trim())
    const name = $('userName').value.trim()
    const res = api.addUser({ id: Number.isFinite(id) && id > 0 ? id : null, username: name })
    Promise.resolve(res).then((r) => {
      if (r && !r.ok) status(r.error, true)
      else { $('userId').value = ''; $('userName').value = ''; status('已加入屏蔽名单') }
    })
  })
  $('addAccount').addEventListener('click', () => {
    const name = $('accountName').value.trim() || '账号'
    api.accountAdd(name).then((next) => {
      $('accountName').value = ''
      apply(next)
      api.openSite({ account: (next.accounts[next.accounts.length - 1] || {}).id })
    })
  })
  $('notifyOn').addEventListener('change', (e) => api.setSettings({ notifications: e.target.checked }))
  $('notifyInterval').addEventListener('change', (e) => api.setSettings({ notifyIntervalSec: Number(e.target.value) }))
  $('closeToTray').addEventListener('change', (e) => api.setSettings({ closeToTray: e.target.checked }))
  $('fabOn').addEventListener('change', (e) => api.setSettings({ showPageFab: e.target.checked }))
  $('autoClearMail').addEventListener('change', (e) => {
    if (e.target.checked && !confirm('开启后，客户端会调用站点接口把被屏蔽者的会话标记为已读。这会改动服务器上的已读状态，且不可撤销。确认开启？')) {
      e.target.checked = false
      return
    }
    api.setSettings({ autoClearBlockedMail: e.target.checked })
  })
  $('dumpShapes').addEventListener('change', (e) => api.setSettings({ dumpShapes: e.target.checked }))
  $('export').addEventListener('click', () => api.exportList().then((r) => status(r.ok ? '已导出 ' + r.path : r.error, !r.ok)))
  $('import').addEventListener('click', () => api.importList().then((r) => {
    if (r.ok) status('导入完成，新增 ' + r.added + ' 条')
    else status(r.error, true)
  }))
  $('openSite').addEventListener('click', () => api.openSite({}))
  $('openPluginFolder').addEventListener('click', () => api.openPluginFolder())
  $('refreshPlugins').addEventListener('click', () => renderPlugins())
  $('loginAccount').addEventListener('change', renderLoginAccounts)
  $('openTokenPage').addEventListener('click', () => api.openTokenPage())
  $('doLogin').addEventListener('click', () => {
    const btn = $('doLogin')
    btn.disabled = true
    $('loginState').textContent = '正在换取登录状态…'
    api.loginWithToken({ account: $('loginAccount').value, token: $('loginToken').value }).then((r) => {
      btn.disabled = false
      if (r.ok) {
        $('loginState').textContent = '已登录：' + r.nickname
        $('loginState').className = ''
        $('loginToken').value = ''
        api.openSite({ account: $('loginAccount').value })
      } else {
        $('loginState').textContent = r.error
        $('loginState').className = 'err'
      }
    })
  })
  api.onChanged((next) => { snap = next; apply() })
}

api.get().then((next) => {
  snap = next
  apply()
  wire()
})
