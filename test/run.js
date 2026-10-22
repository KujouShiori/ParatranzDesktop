'use strict'

const fs = require('fs')
const path = require('path')
const P = require('../src/shared/pure')

let failed = 0
let passed = 0

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
  } else {
    failed++
    console.log('FAIL  ' + name + '\n      expected ' + e + '\n      actual   ' + a)
  }
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
}

function rules(obj) {
  return P.normalizeRules(obj)
}

const list = fixture('projects_page_1_pageSize_2.json')
const detail = fixture('projects_10709.json')
const members = fixture('projects_10709_members_page_1_pageSize_3.json')
const leaderboard = fixture('users_leaderboard_page_1_pageSize_2.json')

// 1. 屏蔽项目后，列表里不再出现该项目
{
  const blockedId = list.results[0].id
  const data = JSON.parse(JSON.stringify(list))
  const stats = P.filterJson(data, rules({ projects: [{ id: blockedId }] }), P.parseSiteUrl('/api/projects'))
  check('listing drops blocked project', data.results.map((p) => p.id), [list.results[1].id])
  check('listing decrements rowCount', data.rowCount, list.rowCount - 1)
  check('listing stats', stats.droppedProjects, 1)
}

// 2. 项目详情接口按 URL 硬屏蔽
check('detail url is hard blocked', P.urlTargetsBlockedProject(rules({ projects: [{ id: 10709 }] }), '/api/projects/10709'), 10709)
check('detail sub resource is hard blocked', P.urlTargetsBlockedProject(rules({ projects: [{ id: 10709 }] }), '/api/projects/10709/terms?page=1'), 10709)
check('other project url passes', P.urlTargetsBlockedProject(rules({ projects: [{ id: 10709 }] }), '/api/projects/10710/terms'), 0)
check('blocked page url', P.urlTargetsBlockedProject(rules({ projects: [{ id: 10709 }] }), 'https://paratranz.cn/projects/10709/strings'), 10709)

// 3. 成员表按 project 外键整行剔除
{
  const data = JSON.parse(JSON.stringify(members))
  P.filterJson(data, rules({ projects: [{ id: 10709 }] }), P.parseSiteUrl('/api/projects/10709/members'))
  check('member rows dropped via project field', data.length, 0)
}

// 4. id 撞车不能误删：把成员行的 id 当作被屏蔽项目 id
{
  const data = JSON.parse(JSON.stringify(members))
  P.filterJson(data, rules({ projects: [{ id: members[0].id }] }), P.parseSiteUrl('/api/projects/10709/members'))
  check('member id collision ignored', data.length, members.length)
}

// 5. stats 这种「id 等于项目 id 但没有 name」的对象不能被当成项目
check('stats is not a project entity', P.isProjectEntity(detail.stats), false)
check('project entity detection', P.isProjectEntity(list.results[0]), true)
check('member row is not a project entity', P.isProjectEntity(members[0]), false)

// 6. 屏蔽用户：成员表里整行消失
{
  const data = JSON.parse(JSON.stringify(members))
  const victim = members[2].user.id
  P.filterJson(data, rules({ users: [{ id: victim }] }), P.parseSiteUrl('/api/projects/10709/members'))
  check('blocked member row dropped', data.length, members.length - 1)
  check('victim gone', data.some((m) => m.user && m.user.id === victim), false)
  check('other members intact', [data[0].user.id, data[1].user.id], [members[0].user.id, members[1].user.id])
  check('no row left with null user', data.filter((m) => !m.user).length, 0)
}

// 7. 屏蔽用户名：排行榜里该用户被移除
{
  const data = JSON.parse(JSON.stringify(leaderboard))
  const name = leaderboard[0].username
  P.filterJson(data, rules({ users: [{ username: name }] }), P.parseSiteUrl('/api/users/leaderboard'))
  check('leaderboard entry dropped by name', data.length, leaderboard.length - 1)
}

// 8. 翻译数据保护：非 feed 场景下被屏蔽作者只脱名，条目一条都不能少
{
  const termPayload = {
    results: [
      {
        id: 900,
        key: 'a/b.txt|1',
        zh: '你好',
        ja: 'こんにちは',
        values: [
          { id: 1, zh: '你好', user: { id: 42, username: 'spammer', nickname: '喷子', avatar: '/a.png' } },
          { id: 2, zh: '您好', user: { id: 43, username: 'goodguy', nickname: '好人', avatar: '/b.png' } }
        ]
      }
    ],
    page: 1,
    rowCount: 1
  }
  const data = JSON.parse(JSON.stringify(termPayload))
  const stats = P.filterJson(data, rules({ users: [{ id: 42 }] }), P.parseSiteUrl('/api/projects/10709/terms'))
  check('terms count intact', data.results.length, 1)
  check('values count intact', data.results[0].values.length, 2)
  check('translation text intact', data.results[0].values.map((v) => v.zh), ['你好', '您好'])
  check('blocked author masked', data.results[0].values[0].user.username, P.MASK_TEXT)
  check('blocked author nickname masked', data.results[0].values[0].user.nickname, P.MASK_TEXT)
  check('free author untouched', data.results[0].values[1].user.username, 'goodguy')
  check('mask counted as masked not dropped', [stats.maskedUsers, stats.droppedUsers], [1, 0])
}

// 9. 临时解除
{
  const r = rules({ projects: [{ id: 10709 }], users: [{ id: 42, username: 'spammer' }], reveal: { projectIds: [10709] } })
  check('reveal single project', P.projectBlocked(r, 10709), false)
  check('blocked user still blocked', P.userEntityBlocked(r, { id: 42, username: 'spammer' }), true)
  const r2 = rules({ projects: [{ id: 10709 }], users: [{ id: 42, username: 'spammer' }], reveal: { all: true } })
  check('reveal all projects', P.projectBlocked(r2, 10709), false)
  check('reveal all users', P.userEntityBlocked(r2, { id: 42, username: 'spammer' }), false)
}

// 10. URL 解析
check('parse api url', P.parseSiteUrl('/api/projects/10709/strings?taskId=3'), { projectId: 10709, userId: null, apiPath: '/projects/10709/strings', pagePath: null, foreign: false })
check('parse user url', P.parseSiteUrl('https://paratranz.cn/users/42/activities'), { projectId: null, userId: 42, apiPath: null, pagePath: '/users/42/activities', foreign: false })
check('parse list url', P.parseSiteUrl('/projects'), { projectId: null, userId: null, apiPath: null, pagePath: '/projects', foreign: false })
check('empty url', P.parseSiteUrl(''), { projectId: null, userId: null, apiPath: null, pagePath: null, foreign: false })
check('foreign url ignored', P.parseSiteUrl('https://evil.test/projects/10709'), { projectId: null, userId: null, apiPath: null, pagePath: null, foreign: true })
check('foreign url cannot hard block', P.urlTargetsBlockedProject(rules({ projects: [{ id: 10709 }] }), 'https://evil.test/projects/10709'), 0)
check('static subdomain is not site routing', P.parseSiteUrl('https://static.paratranz.cn/media/x.png').foreign, false)

// 11. 真实形状回归：文件行不是项目，文件 id 与被屏蔽项目 id 撞车时不能误删
{
  const files = fixture('files_list.json')
  check('文件行不被当成项目实体', P.isProjectEntity(files[0]), false)
  const blockedOwnId = JSON.parse(JSON.stringify(files))
  P.filterJson(blockedOwnId, rules({ projects: [{ id: 777 }] }), P.parseSiteUrl('/api/projects/5000/files'))
  check('按 project 外键剔除文件行', blockedOwnId.map((f) => f.id), [18245, 777])
  check('id 撞车的文件行存活（它的 project 是 5000）', blockedOwnId.some((f) => f.id === 777 && f.project === 5000), true)
  const blockedProject = JSON.parse(JSON.stringify(files))
  P.filterJson(blockedProject, rules({ projects: [{ id: 18245 }] }), P.parseSiteUrl('/api/projects/18245/files'))
  check('被屏蔽项目的文件整行消失', blockedProject.map((f) => f.id), [99, 777])
}

// 12. 真实形状回归：项目引用是对象 { id, name }
{
  const terms = fixture('term_values.json')
  const data = JSON.parse(JSON.stringify(terms))
  P.filterJson(data, rules({ projects: [{ id: 18245 }] }), P.parseSiteUrl('/api/projects/18245/terms?page=1'))
  check('对象形式的 project 也能命中', data.results.map((t) => t.id), [4002])
  check('对象命中后 rowCount 同步', data.rowCount, 1)
}

// 13. 真实形状回归：被屏蔽用户的 bio 与 email 也要脱敏，译文正文一条不能少
{
  const terms = fixture('term_values.json')
  const data = JSON.parse(JSON.stringify(terms))
  const stats = P.filterJson(data, rules({ users: [{ id: 4242 }] }), P.parseSiteUrl('/api/projects/5000/terms?page=1'))
  check('词条条数不变', data.results.length, 2)
  check('译文正文不变', data.results.map((t) => t.translation), ['你好', '再见'])
  const victim = data.results[0].user
  const other = data.results[1].user
  check('用户名脱敏', victim.username, P.MASK_TEXT)
  check('昵称脱敏', victim.nickname, P.MASK_TEXT)
  check('bio 被清空', victim.bio, '')
  check('email 被清空', victim.email, '')
  check('未被屏蔽者不受影响', [other.username, other.email], ['goodguy', 'other@example.invalid'])
  check('只记脱敏不记删除', [stats.maskedUsers, stats.droppedUsers], [1, 0])
}

// 14. 实测的私信列表：发信人被屏蔽整行消失，收信人被屏蔽只脱名不删行
{
  const mails = fixture('mails_list.json')
  const asSender = JSON.parse(JSON.stringify(mails))
  const s1 = P.filterJson(asSender, rules({ users: [{ id: 900001 }] }), P.parseSiteUrl('/api/mails?page=1'))
  check('私信：发信人被屏蔽后整行消失', asSender.results.map((m) => m.id), [700002])
  check('私信：rowCount 同步', asSender.rowCount, 1)
  check('私信：留下的行不受影响', asSender.results[0].fromUser.username, 'other-guy')

  const asRecipient = JSON.parse(JSON.stringify(mails))
  P.filterJson(asRecipient, rules({ users: [{ id: 1 }] }), P.parseSiteUrl('/api/mails?page=1'))
  check('私信：收信人被屏蔽时行还在', asRecipient.results.length, 2)
  check('私信：收信人只脱名', asRecipient.results[0].toUser.username, P.MASK_TEXT)
  check('私信：发信人不受收信人屏蔽影响', asRecipient.results[0].fromUser.username, 'example-sender')
  check('私信：邮箱一并清空', asRecipient.results[0].toUser.email, '')
}

// 15. 实测的站内消息：没有 fromUser 只有数字 from 的变体也要按 id 拦掉
{
  const messages = fixture('messages_list.json')
  const data = JSON.parse(JSON.stringify(messages))
  P.filterJson(data, rules({ users: [{ id: 900001 }] }), P.parseSiteUrl('/api/messages?page=1'))
  check('消息：带 fromUser 与只有数字 from 的两种都被拦', data.results.map((m) => m.id), [800003])

  const byProject = JSON.parse(JSON.stringify(messages))
  P.filterJson(byProject, rules({ projects: [{ id: 777 }] }), P.parseSiteUrl('/api/messages?page=1'))
  check('消息：link.project 命中被屏蔽项目', byProject.results.map((m) => m.id), [800001])
}

// 16. 隐私护栏：夹具只放合成数据，真实账号信息一旦提交就会公开留在历史里
{
  const dir = path.join(__dirname, 'fixtures')
  const offenders = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    if (/avatars\.githubusercontent\.com|githubusercontent/.test(text)) offenders.push(f + ' 含真实头像域名')
    const nameRe = /"(?:username|nickname)"\s*:\s*"([^"]*)"/g
    let m
    while ((m = nameRe.exec(text))) {
      const value = m[1]
      if (!/^(example|goodguy|other-guy|spammer|someone|ok|OK|小A|好人|喷子|路人|示例|我自己|已屏蔽)/.test(value)) offenders.push(f + ' 含疑似真实用户名 ' + value)
    }
    if (/@(?!(?:example|someone)\.)[a-z0-9.-]+\.(com|cn|net|org)/i.test(text.replace(/@example\.invalid/g, ''))) offenders.push(f + ' 含疑似真实邮箱')
  }
  check('夹具里没有真实账号信息', offenders, [])
}

console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
