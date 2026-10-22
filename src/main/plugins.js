'use strict'

const fs = require('fs')
const path = require('path')
const { app, shell } = require('electron')
const us = require('../shared/userscript')
const store = require('./store')

// 插件就是丢文件：userData/plugins 下的 .user.js / .js / .css 自动生效。
// 不装 Chromium 扩展，因为 Electron 44 的 ses.extensions 只认清单、不执行 content script。
function dir() {
  const d = path.join(app.getPath('userData'), 'plugins')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function disabledSet() {
  const list = store.snapshot().settings.pluginsDisabled
  return new Set(Array.isArray(list) ? list : [])
}

function readEntries() {
  const root = dir()
  const out = []
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch (e) {
    return out
  }
  for (const name of names.sort()) {
    const full = path.join(root, name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch (e) {
      continue
    }
    if (!stat.isFile()) continue
    const ext = path.extname(name).toLowerCase()
    if (!['.js', '.user.js', '.css'].includes(ext)) continue
    let code
    try {
      code = fs.readFileSync(full, 'utf8')
    } catch (e) {
      continue
    }
    const isCss = ext === '.css'
    const meta = isCss ? { name: '', matches: [], includes: [] } : us.parseHeader(code)
    out.push({
      file: name,
      name: meta.name || name,
      kind: isCss ? 'css' : 'js',
      code: code,
      matches: meta.matches,
      includes: meta.includes,
      bytes: stat.size,
      enabled: !disabledSet().has(name)
    })
  }
  return out
}

function sourceFor(kind) {
  const entries = readEntries().filter((e) => e.kind === kind && e.enabled)
  if (!entries.length) return ''
  return kind === 'css' ? us.buildCssSource(entries) : us.buildInjectedSource(entries)
}

function injectedSource() {
  return [sourceFor('js'), sourceFor('css')].filter(Boolean).join('\n')
}

function toggle(file, on) {
  const set = disabledSet()
  if (on) set.delete(file)
  else set.add(file)
  store.updateSettings({ pluginsDisabled: Array.from(set) })
  return { ok: true }
}

function list() {
  return readEntries().map((e) => ({
    file: e.file,
    name: e.name,
    kind: e.kind,
    bytes: e.bytes,
    enabled: e.enabled,
    matches: e.matches.concat(e.includes)
  }))
}

function openFolder() {
  return shell.openPath(dir())
}

module.exports = { dir, injectedSource, list, openFolder, toggle }
