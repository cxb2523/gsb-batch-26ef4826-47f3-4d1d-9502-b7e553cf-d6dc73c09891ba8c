'use strict';

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// 测试入口：用 Node 内置测试运行器执行 tests/*.test.mjs。
// 通过 --import 注册加载钩子，使 renderer 的 .js 源码按 ESM 解析、CSS 导入变成空模块，
// 从而无需 Vite/Electron 依赖即可在纯 Node 环境里直接测试前端字幕层与主进程字幕服务。
const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');
const loader = pathToFileURL(path.join(testsDir, 'register-loader.mjs')).href;

// 显式枚举测试文件，避免依赖不同 Node 版本对目录/通配符参数的处理差异。
const files = fs.readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.mjs') || name.endsWith('.test.cjs'))
  .sort()
  .map((name) => path.join(testsDir, name));

if (!files.length) {
  console.error('未找到测试文件（tests/*.test.mjs）');
  process.exit(1);
}

const args = [
  '--no-warnings',
  '--import', loader,
  '--test',
  ...files,
  ...process.argv.slice(2)
];

const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
