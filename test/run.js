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

console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
