'use strict'

const fs = require('fs')
const path = require('path')
const pure = require('../src/shared/pure')
const shape = require('../src/shared/notify')

let failed = 0
let passed = 0

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) passed++
  else {
    failed++
    console.log('FAIL  ' + name + '\n      expected ' + e + '\n      actual   ' + a)
  }
}

function rules(obj) {
  return pure.normalizeRules(obj)
}

const notifFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'synthetic_notifications.json'), 'utf8'))

// 列表外壳兼容
check('取 results 外壳', shape.itemsOf({ results: [1, 2] }), [1, 2])
check('取裸数组', shape.itemsOf([1, 2]).length, 2)
check('取 rows 外壳', shape.itemsOf({ rows: [1] }), [1])
check('垃圾输入返回空', shape.itemsOf('nope'), [])
check('无 id 时用下标', shape.idOf({ content: 'x' }, 3), 'idx-3')
check('有 id 时用 id', shape.idOf({ id: 77 }, 3), '77')

// 被屏蔽项目不发提醒
{
  const r = rules({ projects: [{ id: 18245 }] })
  const items = shape.itemsOf(notifFixture)
  check('命中被屏蔽项目', items.filter((it) => shape.shouldSkip(it, r)).length, 1)
  check('其它条目不受影响', items.filter((it) => !shape.shouldSkip(it, r)).length, 2)
}

// 被屏蔽用户：嵌套 user 与内联 username 两种写法都要拦住
{
  const r = rules({ users: [{ username: 'spammer' }] })
  const items = shape.itemsOf(notifFixture)
  const skipped = items.filter((it) => shape.shouldSkip(it, r))
  check('嵌套 author 与内联 username 都命中', skipped.length, 1)
  check('命中的是那条审核通知', skipped[0].type, 'review')
}

// projectId 外键写法
check('projectId 外键识别', shape.projectIdsOf({ projectId: 5, project: 6, uid: 9 }), [5, 6])
check('内联 project 对象识别', shape.projectIdsOf({ project: { id: 12, name: 'x' } }), [12])

// 文案
{
  const item = { projectName: 'MLTD 汉化', user: { id: 3, username: 'aaa', nickname: '小A' }, content: '你的译文\n已被通过', id: 1 }
  check('标题带项目与昵称', shape.titleOf(item, 'mails'), '[MLTD 汉化] 小A 站内信')
  check('正文压掉换行', shape.bodyOf(item), '你的译文 已被通过')
  const long = { content: '字'.repeat(200) }
  check('超长正文截断', shape.bodyOf(long).length, 121)
  check('没有可读字段时正文为空', shape.bodyOf({ id: 1 }), '')
  check('消息源标签', shape.titleOf({ user: { username: 'bob' } }, 'messages'), 'bob 消息')
}

// 解除屏蔽后恢复提醒
{
  const r = rules({ projects: [{ id: 18245 }], reveal: { all: true } })
  check('临时解除后不再拦提醒', shape.itemsOf(notifFixture).filter((it) => shape.shouldSkip(it, r)).length, 0)
}

// 去重键：会话 id 不变但来了新消息时，必须算作新的一条
{
  const conv = { id: 55, user: { id: 7, username: 'a' }, updatedAt: '2026-10-22T01:00:00Z', lastContent: '第一句' }
  const same = { id: 55, user: { id: 7, username: 'a' }, updatedAt: '2026-10-22T01:00:00Z', lastContent: '第一句' }
  const newer = { id: 55, user: { id: 7, username: 'a' }, updatedAt: '2026-10-22T02:00:00Z', lastContent: '第二句' }
  check('同一会话内容没变算重复', shape.keyOf(conv, 0) === shape.keyOf(same, 0), true)
  check('同一会话来了新消息算新条目', shape.keyOf(conv, 0) === shape.keyOf(newer, 0), false)
  check('只有 id 的条目按 id 去重', shape.keyOf({ id: 9 }, 3), '9')
  check('没有 id 时用下标兜底', shape.keyOf({ content: 'x' }, 3).startsWith('idx-3'), true)
  const longA = { id: 1, content: '啊'.repeat(300) }
  const longB = { id: 1, content: '啊'.repeat(301) }
  check('超长正文靠长度区分', shape.keyOf(longA, 0) === shape.keyOf(longB, 0), false)
  check('同一条超长正文稳定', shape.keyOf(longA, 0) === shape.keyOf({ id: 1, content: '啊'.repeat(300) }, 0), true)
}

console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
