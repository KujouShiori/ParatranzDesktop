'use strict'

// 插件的纯逻辑：解析 Tampermonkey 风格的头部注释、@match/@include 语义，
// 并把若干脚本拼成一段能直接打进页面主世界的源码。
// 注入代码里刻意只用字符串比较（不出现正则字面量、不出现反斜杠转义），
// 避免「字符串里套正则」这种多层转义把匹配逻辑写坏；通配在编译期就拆成片段。

const HEADER_RE = /\/\/[ \t]*==UserScript==[\s\S]*?\/\/[ \t]*==\/UserScript==/

function parseHeader(source) {
  const meta = { name: '', matches: [], includes: [], runAt: 'document-start' }
  const block = HEADER_RE.exec(String(source || ''))
  if (!block) return meta
  for (const line of block[0].split(/\r?\n/)) {
    const m = /^\/\/[ \t]*@([A-Za-z-]+)[ \t]+(.+?)[ \t]*$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'name' && !meta.name) meta.name = value
    else if (key === 'match' || key === 'include') meta[key === 'match' ? 'matches' : 'includes'].push(value)
  }
  return meta
}

// 通配拆片段：prefix + 中间必须按序出现的段 + suffix
function compilePattern(pattern) {
  const text = String(pattern || '')
  if (!text) return null
  const segs = text.split('*')
  return {
    prefix: segs[0],
    middle: segs.slice(1, -1),
    suffix: segs.length > 1 ? segs[segs.length - 1] : '',
    exact: segs.length === 1
  }
}

function compiledMatch(compiled, href) {
  if (!compiled) return false
  let at = 0
  if (compiled.prefix) {
    if (!href.startsWith(compiled.prefix)) return false
    at = compiled.prefix.length
  }
  for (const seg of compiled.middle) {
    if (!seg) continue
    const k = href.indexOf(seg, at)
    if (k < 0) return false
    at = k + seg.length
  }
  if (compiled.exact) return href === compiled.prefix
  if (compiled.suffix) {
    const tail = href.slice(at)
    return tail.endsWith(compiled.suffix) && tail.length >= compiled.suffix.length
  }
  return true
}

function urlMatches(patterns, href) {
  for (const p of patterns || []) {
    if (p === '*') return true
    if (compiledMatch(compilePattern(p), href)) return true
  }
  return false
}

function shouldRun(entry, href) {
  const patterns = (entry.matches || []).concat(entry.includes || [])
  if (!patterns.length) return true
  return urlMatches(patterns, href)
}

// 运行时判断用的源码：只有字符串方法，没有任何转义陷阱
const RUNTIME = [
  'function __ptCompiledHit(c, href) {',
  '  var at = 0;',
  '  if (c.prefix) { if (href.indexOf(c.prefix) !== 0) return false; at = c.prefix.length; }',
  '  for (var i = 0; i < c.middle.length; i++) {',
  '    var seg = c.middle[i];',
  '    if (!seg) continue;',
  '    var k = href.indexOf(seg, at);',
  '    if (k < 0) return false;',
  '    at = k + seg.length;',
  '  }',
  '  if (c.exact) return href === c.prefix;',
  '  if (c.suffix) { var tail = href.slice(at); return tail.length >= c.suffix.length && tail.lastIndexOf(c.suffix) === tail.length - c.suffix.length; }',
  '  return true;',
  '}',
  'function __ptMatch(specs, href) {',
  '  for (var j = 0; j < specs.length; j++) {',
  '    var s = specs[j];',
  '    if (s.star) return true;',
  '    if (__ptCompiledHit(s, href)) return true;',
  '  }',
  '  return false;',
  '}'
].join('\n')

function toSpec(pattern) {
  const c = compilePattern(pattern)
  if (!c) return null
  return { prefix: c.prefix, middle: c.middle, suffix: c.suffix, exact: c.exact, star: pattern === '*' }
}

function buildInjectedSource(entries) {
  const list = (entries || []).filter((e) => e && String(e.code || '').trim())
  if (!list.length) return ''
  const parts = ['(function(){', '"use strict";', RUNTIME]
  for (const entry of list) {
    const patterns = (entry.matches || []).concat(entry.includes || []).map(toSpec).filter(Boolean)
    const label = String(entry.name || entry.file || 'plugin').replace(/[^\w.\- ]/g, '')
    parts.push('try{if(' + (patterns.length ? '__ptMatch(' + JSON.stringify(patterns) + ', location.href)' : 'true') + '){(function(){')
    parts.push(String(entry.code))
    parts.push('})();}}catch(e){console.warn(' + JSON.stringify('[插件 ' + label + '] 出错: ') + ', e);}')
  }
  parts.push('})();')
  return parts.join('\n')
}

function buildCssSource(entries) {
  const blocks = (entries || []).filter((e) => e && String(e.code || '').trim())
  if (!blocks.length) return ''
  const css = blocks.map((e) => '/* ' + (e.name || e.file) + ' */\n' + e.code).join('\n')
  return '(function(){var s=document.createElement("style");s.id="pt-plugin-css";s.textContent=' +
    JSON.stringify(css) + ';(document.head||document.documentElement).appendChild(s);})();'
}

module.exports = {
  buildCssSource,
  buildInjectedSource,
  parseHeader,
  shouldRun,
  urlMatches
}
