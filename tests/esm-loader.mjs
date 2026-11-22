import { fileURLToPath } from 'node:url';

// 加载钩子：
//  1. renderer 源码（src/*.js）在 package.json 未声明 type:module 时会被 Node 当作 CommonJS，
//     这里按 ESM 解析，以便测试直接 import 前端模块；
//  2. 前端模块里的 `import './x.css'` 在 Node 下没有意义，直接映射为空模块。
// 只处理本仓库 src/ 目录，避免影响 node_modules 里的正常 ESM。
const SRC_PREFIX = fileURLToPath(new URL('../src/', import.meta.url)).replace(/\\/g, '/');

function isSrcModule(url) {
  if (!url || !url.startsWith('file:')) return false;
  let filePath = '';
  try { filePath = fileURLToPath(url).replace(/\\/g, '/'); } catch { return false; }
  return filePath.startsWith(SRC_PREFIX) && filePath.endsWith('.js');
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.css')) {
    return { url: 'data:text/javascript,export default {}', shortCircuit: true };
  }
  const result = await nextResolve(specifier, context);
  if (isSrcModule(result && result.url)) {
    return { ...result, format: 'module' };
  }
  return result;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (isSrcModule(url)) {
    return { ...result, format: 'module' };
  }
  return result;
}
