'use strict'

const { shell, session } = require('electron')
const windows = require('./windows')

// 站点没有给我们可用的回调通道：OAuth 走完是在 paratranz.cn 上种 cookie，
// cookie 落在他自己的浏览器里，客户端拿不到。所以「用系统浏览器登录」的正解是
// 个人中心里那枚 32 位 Token：浏览器里复制，客户端用 POST /oauth/token 在
// 该账号自己的会话里换回 sid cookie，全程不需要在内置窗口里输账号密码。
const TOKEN_URL = 'https://paratranz.cn/oauth/token'
const ACCOUNT_PROBE = 'https://paratranz.cn/api/account'
const TOKEN_PAGE = 'https://paratranz.cn/account'

function openTokenPage() {
  return shell.openExternal(TOKEN_PAGE)
}

async function loginWithToken(account, token) {
  const value = String(token || '').trim()
  if (!/^[A-Za-z0-9]{32}$/.test(value)) {
    return { ok: false, error: 'Token 应该是 32 位字母数字，检查一下有没有漏掉或多了空格' }
  }
  const ses = windows.sessionFor(account)
  let res
  try {
    res = await ses.fetch(TOKEN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: 'token=' + encodeURIComponent(value)
    })
  } catch (e) {
    return { ok: false, error: '请求失败：' + String(e && e.message ? e.message : e) }
  }

  const location = res.headers.get('location') || ''
  if (/fail=1/.test(location)) {
    const msg = decodeURIComponent((/[?&]message=([^&]*)/.exec(location) || ['', ''])[1].replace(/\+/g, ' '))
    return { ok: false, error: '站点拒绝了这个 Token' + (msg ? '：' + msg : '') }
  }

  // 换 cookie 成功与否不能只看返回码，直接问一次「我是谁」
  try {
    const me = await ses.fetch(ACCOUNT_PROBE, { headers: { accept: 'application/json' } })
    const text = (await me.text()).trim()
    if (!text) return { ok: false, error: 'Token 被接受了，但登录状态没有建立（会话里仍然是未登录）' }
    const user = JSON.parse(text)
    if (!user || !user.username) return { ok: false, error: '登录状态校验失败：账号接口返回里没有用户名' }
    return { ok: true, username: user.username, nickname: user.nickname || user.username, account: account }
  } catch (e) {
    return { ok: false, error: '登录状态校验失败：' + String(e && e.message ? e.message : e) }
  }
}

async function whoami(account) {
  try {
    const res = await windows.sessionFor(account).fetch(ACCOUNT_PROBE, { headers: { accept: 'application/json' } })
    const text = (await res.text()).trim()
    if (!text) return { logged: false }
    const user = JSON.parse(text)
    return { logged: true, username: user.username, nickname: user.nickname || user.username }
  } catch (e) {
    return { logged: false, error: String(e && e.message ? e.message : e) }
  }
}

module.exports = { loginWithToken, openTokenPage, whoami }
