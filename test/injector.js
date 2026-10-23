'use strict'

// document-start 脚本是一次性注册的字符串，规则烤在字符串里。
// 这里用假 webContents 验证：规则变了必须重登记，否则重载会带着旧规则启动，
// 「临时解除」就变成墙消失了但数据仍然取不回来。

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

function fakeWc() {
  const cmds = []
  return {
    cmds: cmds,
    scripts: [],
    evaluated: [],
    destroyed: false,
    debugger: {
      attached: false,
      attach() { this.attached = true },
      detach() { this.attached = false },
      on() {},
      isAttached() { return this.attached },
      sendCommand(method, params) {
        cmds.push({ method: method, identifier: params && params.identifier })
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          const id = 'script-' + cmds.length
          cmds[cmds.length - 1].source = params.source
          return Promise.resolve({ identifier: id })
        }
        return Promise.resolve({})
      }
    },
    isDevToolsOpened() { return false },
    isDestroyed() { return this.destroyed },
    executeJavaScript(code) {
      this.evaluated.push(code)
      return Promise.resolve(undefined)
    },
    on() {},
    removeListener() {},
    registeredSources() {
      const live = new Map()
      for (const c of this.cmds) {
        if (c.method === 'Page.addScriptToEvaluateOnNewDocument') live.set(c.identifier, c.source)
        if (c.method === 'Page.removeScriptToEvaluateOnNewDocument') live.delete(c.identifier)
      }
      return Array.from(live.values())
    }
  }
}

const injector = require('../src/main/injector')

async function main() {
  const wc = fakeWc()
  const stateA = { projectIds: [10709], userIds: [], userNames: [], revealAll: false, revealProjectIds: [], revealUserKeys: [] }
  const stateB = Object.assign({}, stateA, { revealProjectIds: [10709] })

  const mode = await injector.install(wc, stateA)
  check('CDP 注入路径可用', mode, 'cdp')
  check('注册了一份 document-start 脚本', wc.registeredSources().length, 1)
  check('首次注册烤进了当时的规则', wc.registeredSources()[0].indexOf('"projectIds":[10709]') >= 0, true)

  const ok = await injector.pushRules(wc, stateB)
  check('下发规则成功', ok, true)
  const sources = wc.registeredSources()
  check('规则变化后仍只有一份生效脚本（旧的已注销）', sources.length, 1)
  check('生效脚本带上了新的解除状态', sources[0].indexOf('"revealProjectIds":[10709]') >= 0, true)
  check('生效脚本不再是旧规则的快照', sources[0].indexOf('"revealProjectIds":[]') >= 0, false)
  check('也给当前文档下发了一次', wc.evaluated.some((c) => c.indexOf('"revealProjectIds":[10709]') >= 0), true)
  check('注销旧脚本的命令确实发过', wc.cmds.some((c) => c.method === 'Page.removeScriptToEvaluateOnNewDocument'), true)

  const before = wc.cmds.length
  await injector.pushRules(wc, stateB)
  check('规则没变就不重复注册', wc.cmds.slice(before).some((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument'), false)
  check('规则没变仍会同步当前文档', wc.evaluated.length > 1, true)

  // 没有会话的 webContents（例如已经关掉的窗口）不能抛异常
  const ok2 = await injector.pushRules(fakeWc(), stateB)
  check('未安装过的窗口下发失败但不抛异常', ok2, false)

  console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.log('FAILED  测试本身崩了', e)
  process.exit(1)
})
