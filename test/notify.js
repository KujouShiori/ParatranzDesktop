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

// 实测形状：私信 { results:[{ id, from, to, content, html, fromUser, toUser, uid, user }] }
// 消息 { results:[{ id, from, to, type, content:{text}, target, tid, link:{id,title,project}, fromUser? }] }
{
  const mails = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mails_list.json'), 'utf8'))
  const messages = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'messages_list.json'), 'utf8'))
  const mailItems = shape.itemsOf(mails)
  const msgItems = shape.itemsOf(messages)

  check('私信条目数', mailItems.length, 2)
  check('消息条目数', msgItems.length, 3)

  const bySender = rules({ users: [{ id: 900001 }] })
  check('私信：发信人被屏蔽就不提醒', mailItems.filter((i) => shape.shouldSkip(i, bySender)).length, 1)
  check('消息：带 fromUser 的条目被拦', msgItems.filter((i) => shape.shouldSkip(i, bySender)).length, 2)

  const byName = rules({ users: [{ username: 'example-sender' }] })
  check('私信：按用户名也能拦', mailItems.filter((i) => shape.shouldSkip(i, byName)).length, 1)

  const byRecipient = rules({ users: [{ id: 1 }] })
  check('私信：对方是收信人时同样不提醒', mailItems.filter((i) => shape.shouldSkip(i, byRecipient)).length, 2)

  const byProject = rules({ projects: [{ id: 777 }] })
  check('消息：link.project 命中被屏蔽项目', msgItems.filter((i) => shape.shouldSkip(i, byProject)).length, 2)
  check('link.project 被识别为项目引用', shape.projectIdsOf(msgItems[0]), [18245])

  check('消息正文取自 content.text', shape.bodyOf(msgItems[0]), '你的译文已通过审核')
  check('正文回退到 link.title', shape.bodyOf({ id: 1, link: { title: '某词条的评论' } }), '某词条的评论')
  check('私信正文用 content 字符串', shape.bodyOf(mailItems[1]), '无关的人发的')
  check('标题优先用 fromUser 昵称', shape.titleOf(msgItems[0], 'messages'), '示例发件人 消息')
  check('空名单一条都不拦', msgItems.filter((i) => shape.shouldSkip(i, rules({}))).length, 0)
  check('时间戳不会被当成用户 id', shape.shouldSkip({ id: 1, from: 1697000000000, to: 1697000001000 }, rules({ users: [{ id: 1697000000000 }] })), false)
}

// 自动标已读的筛选：只挑「我收到的 + 未读 + 发信人被屏蔽」
{
  const mails = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mails_list.json'), 'utf8'))
  const items = shape.itemsOf(mails)
  const blockedSender = rules({ users: [{ id: 900001 }] })
  check('只挑出被屏蔽者的会话', shape.blockedUnreadConversations(items, blockedSender, 1), [900001])
  check('没屏蔽任何人时不标任何会话', shape.blockedUnreadConversations(items, rules({}), 1), [])

  const read = [{ id: 1, from: 900001, to: 1, status: 1, uid: 900001, fromUser: { id: 900001, username: 'example-sender' } }]
  check('已读过的不再重复标', shape.blockedUnreadConversations(read, blockedSender, 1), [])

  const sentByMe = [{ id: 2, from: 1, to: 900001, status: 0, uid: 1, fromUser: { id: 1, username: 'example-me' } }]
  check('我发出去的不标（那是对方的已读状态）', shape.blockedUnreadConversations(sentByMe, rules({ users: [{ id: 900001 }] }), 1), [])

  const sameConv = [
    { id: 3, from: 900001, to: 1, status: 0, uid: 900001, fromUser: { id: 900001, username: 'example-sender' } },
    { id: 4, from: 900001, to: 1, status: 0, uid: 900001, fromUser: { id: 900001, username: 'example-sender' } }
  ]
  check('同一会话的多条只标一次', shape.blockedUnreadConversations(sameConv, blockedSender, 1), [900001])
}

// 自己发出去的那条不该提醒自己
{
  const me = 1
  const mine = { id: 700003, from: me, to: 900001, uid: me, content: '我发出去的一句', fromUser: { id: me, username: 'example-me' } }
  const theirs = { id: 700001, from: 900001, to: me, uid: 900001, content: '别人发给我的一句', fromUser: { id: 900001, username: 'example-sender' } }
  check('我发的私信认得出', shape.isSelfAuthored(mine, me), true)
  check('别人发的私信不算我发的', shape.isSelfAuthored(theirs, me), false)
  check('只有数字 from 没有 fromUser 的变体也认得出', shape.isSelfAuthored({ id: 1, from: me, to: 900001 }, me), true)
  check('收信人是自己不算自己发的', shape.isSelfAuthored({ id: 2, from: 900001, to: me }, me), false)
  check('认不出我是谁时一律提醒（宁多不漏）', shape.isSelfAuthored(mine, null), false)
  check('账号 id 取不到为 0 时不误判', shape.isSelfAuthored({ id: 3, from: 0, to: 0 }, 0), false)
  check('时间戳量级的 from 不会被当成我的 id', shape.isSelfAuthored({ from: 1730000000000 }, me), false)
  const msg = { id: 800009, from: me, to: 900001, content: { text: '我触发的一条消息' } }
  check('站内消息里我发起的同样不提醒', shape.isSelfAuthored(msg, me), true)
}

console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
