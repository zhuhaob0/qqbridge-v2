#!/usr/bin/env node
/**
 * 修复 @snowluma/sdk 的 ESM 裸导入
 *
 * 背景（实测）：
 *   npm 上的 @snowluma/sdk@1.14.20 的 dist/*.js 使用 `from './client/api-client'`
 *   这类**无扩展名**的相对导入；Node 的 ESM 解析器不接受，`import '@snowluma/sdk'`
 *   直接抛 ERR_MODULE_NOT_FOUND。而 qq-bridge(v1) 本地安装的那份带 `.js`，所以能跑。
 *
 * 做法：
 *   在 postinstall 里把 dist 下所有相对导入补上 `.js`（只在该文件存在时才补），
 *   幂等、可重复执行。
 *
 *   node tools/fix-snowluma-esm.mjs [--check]
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('node_modules/@snowluma/sdk/dist');
const CHECK_ONLY = process.argv.includes('--check');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith('.js')) out.push(full);
  }
  return out;
}

function fixFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  let changed = 0;

  const patched = source.replace(
    /(from\s+|import\s*\()(['"])(\.{1,2}\/[^'"]+)\2/g,
    (match, prefix, quote, spec) => {
      if (/\.(js|mjs|cjs|json|node)$/.test(spec)) return match;
      const candidate = path.resolve(dir, spec);
      if (fs.existsSync(`${candidate}.js`)) {
        changed += 1;
        return `${prefix}${quote}${spec}.js${quote}`;
      }
      if (fs.existsSync(path.join(candidate, 'index.js'))) {
        changed += 1;
        return `${prefix}${quote}${spec}/index.js${quote}`;
      }
      return match;
    },
  );

  if (changed && !CHECK_ONLY) fs.writeFileSync(file, patched, 'utf8');
  return changed;
}

if (!fs.existsSync(ROOT)) {
  console.log('[fix-snowluma] 未安装 @snowluma/sdk，跳过');
  process.exit(0);
}

let total = 0;
let files = 0;
for (const file of walk(ROOT)) {
  const n = fixFile(file);
  if (n) {
    total += n;
    files += 1;
  }
}

if (CHECK_ONLY) {
  console.log(total ? `[fix-snowluma] 需要修复 ${total} 处（${files} 个文件）` : '[fix-snowluma] 无需修复');
  process.exit(total ? 1 : 0);
}
console.log(total ? `[fix-snowluma] 已修复 ${total} 处（${files} 个文件）` : '[fix-snowluma] 无需修复');
