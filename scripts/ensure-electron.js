'use strict'

// npm 11 的 allow-scripts 闸门会跳过依赖包的安装脚本，electron 下载二进制的 postinstall
// 于是不被执行 —— 表现为 npm install 报成功但 node_modules/electron/dist 是空的。
// 这一步把二进制补上（默认走 npmmirror，可用 ELECTRON_MIRROR 覆盖），
// 让 npm install 之后不需要再手动折腾。
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const electronDir = path.join(root, 'node_modules', 'electron')
const distExe = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8')).version
  } catch (e) {
    return null
  }
}

const ver = version()
if (!ver) {
  console.error('找不到 node_modules/electron，先跑 npm install')
  process.exit(1)
}
if (fs.existsSync(distExe)) {
  console.log('Electron 二进制已就位（v' + ver + '），无需补装')
  process.exit(0)
}

if (!process.env.ELECTRON_MIRROR && !process.env.npm_config_electron_mirror) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  console.log('未指定 ELECTRON_MIRROR，改用 npmmirror 下载')
}

console.log('补装 Electron v' + ver + ' 二进制…')
const res = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
})
if (res.status !== 0 || !fs.existsSync(distExe)) {
  console.error('补装失败。手动试：set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 然后 node node_modules/electron/install.js')
  process.exit(1)
}
console.log('Electron 二进制就位')
