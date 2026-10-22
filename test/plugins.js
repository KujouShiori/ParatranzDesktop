'use strict'

// 关键：这里跑的是 buildInjectedSource 产出的「真要被注入的那段源码」，
// 不是它旁边的等价实现——注入链路的坑只有这样才能暴露。
const us = require('../src/shared/userscript')

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

function runInjected(source, href) {
  const log = []
  const fn = new Function('location', 'console', 'return (async () => {' + source + '})()')
  fn({ href: href }, { warn: (...args) => log.push(args.join(' ')) })
  return log
}

// 头部解析
{
  const src = [
    '// ==UserScript==',
    '// @name         我的辅助脚本',
    '// @match        https://paratranz.cn/projects/*',
    '// @match        https://paratranz.cn/strings*',
    '// @include      *leaderboard*',
    '// @run-at       document-end',
    '// ==/UserScript==',
    'window.__x = 1;'
  ].join('\n')
  const meta = us.parseHeader(src)
  check('解析脚本名', meta.name, '我的辅助脚本')
  check('解析 @match 列表', meta.matches, ['https://paratranz.cn/projects/*', 'https://paratranz.cn/strings*'])
  check('解析 @include', meta.includes, ['*leaderboard*'])
  check('没有头部的脚本', us.parseHeader('window.__y = 2;').matches, [])
}

// 通配语义
check('前缀通配命中', us.urlMatches(['https://paratranz.cn/projects/*'], 'https://paratranz.cn/projects/10709/terms'), true)
check('前缀通配不跨站', us.urlMatches(['https://paratranz.cn/projects/*'], 'https://evil.test/projects/1'), false)
check('星号在中间', us.urlMatches(['*://paratranz.cn/*'], 'https://paratranz.cn/'), true)
check('精确无星号', us.urlMatches(['https://paratranz.cn/about'], 'https://paratranz.cn/about'), true)
check('精确无星号不误伤', us.urlMatches(['https://paratranz.cn/about'], 'https://paratranz.cn/aboutme'), false)
check('后缀通配', us.urlMatches(['https://paratranz.cn/strings*'], 'https://paratranz.cn/strings?taskId=1'), true)
check('包含式 include', us.urlMatches(['*leaderboard*'], 'https://paratranz.cn/projects/9/leaderboard'), true)
check('空模式列表不匹配任何', us.urlMatches([], 'https://paratranz.cn/'), false)
check('无头部默认全跑', us.shouldRun({ matches: [], includes: [] }, 'https://paratranz.cn/anything'), true)

// 注入源码真的会执行，而且按地址过滤
{
  const entries = [
    { name: 'only-projects', matches: ['https://paratranz.cn/projects/*'], includes: [], code: 'globalThis.__hit = (globalThis.__hit||0)+1;' },
    { name: 'always', matches: [], includes: [], code: 'globalThis.__always = (globalThis.__always||0)+1;' }
  ]
  const source = us.buildInjectedSource(entries)
  check('注入源码非空', source.length > 80, true)

  globalThis.__hit = 0
  globalThis.__always = 0
  runInjected(source, 'https://paratranz.cn/projects/10709/terms')
  check('匹配到的脚本执行了', globalThis.__hit, 1)
  check('无头脚本总是执行', globalThis.__always, 1)

  runInjected(source, 'https://paratranz.cn/about')
  check('不匹配时不执行', globalThis.__hit, 1)
  check('不匹配时无头脚本仍执行', globalThis.__always, 2)
}

// 一个插件抛错不能连累其它插件
{
  const entries = [
    { name: 'bad', matches: [], includes: [], code: 'throw new Error("boom")' },
    { name: 'good', matches: [], includes: [], code: 'globalThis.__afterBad = true;' }
  ]
  globalThis.__afterBad = false
  const log = runInjected(us.buildInjectedSource(entries), 'https://paratranz.cn/')
  check('坏插件之后的好插件照样跑', globalThis.__afterBad, true)
  check('坏插件被点名警告', /bad/.test(log.join(' ')), true)
}

// CSS 注入
{
  const src = us.buildCssSource([{ name: 'tune', file: 'tune.css', code: 'body{color:red}' }])
  check('CSS 源码带上了内容', /body\{color:red\}/.test(src), true)
  check('CSS 源码带上了 id', /pt-plugin-css/.test(src), true)
}

// 空输入
check('没有插件时注入源码为空', us.buildInjectedSource([]), '')
check('没有样式时 CSS 为空', us.buildCssSource([]), '')

console.log((failed ? 'FAILED ' : 'ok ') + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
