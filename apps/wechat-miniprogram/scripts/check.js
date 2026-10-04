/**
 * MVP 文件自检脚本
 * 1. 校验所有 JSON 可解析
 * 2. 校验 WXML 里引用的组件都已注册
 * 3. 校验 app.json pages 路径对应的四件套文件齐全
 * 用法：node scripts/check.js
 */
const fs = require('fs');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');          // 项目根（含 cloudfunctions/）
const ROOT = path.join(PROJECT, 'miniprogram');          // 小程序代码根（miniprogramRoot）
let fail = 0;

function walk(dir, acc = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === 'node_modules') continue;
    const p = path.join(dir, item.name);
    if (item.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const all = [...walk(ROOT), ...walk(path.join(PROJECT, 'cloudfunctions'))].sort();

// ===== 0. 工程配置校验（miniprogramRoot / cloudfunctionRoot 必须成对且不嵌套）=====
console.log('--- 工程配置 ---');
const projCfg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'project.config.json'), 'utf8'));
const mpRoot = projCfg.miniprogramRoot;
const cfCfg = projCfg.cloudfunctionRoot;
if (!mpRoot) {
  fail += 1;
  console.log('  FAIL project.config.json 缺 miniprogramRoot');
} else if (!fs.existsSync(path.join(PROJECT, mpRoot, 'app.json'))) {
  fail += 1;
  console.log(`  FAIL miniprogramRoot=${mpRoot} 下找不到 app.json`);
} else {
  console.log(`  OK   miniprogramRoot = ${mpRoot}`);
}
if (!cfCfg) {
  fail += 1;
  console.log('  FAIL project.config.json 缺 cloudfunctionRoot（缺了开发者工具不会显示"上传并部署"）');
} else if (String(cfCfg).indexOf(String(mpRoot || '')) === 0 && mpRoot !== './') {
  fail += 1;
  console.log(`  FAIL cloudfunctionRoot 不能嵌套在 miniprogramRoot 内（${cfCfg} vs ${mpRoot}）`);
} else {
  console.log(`  OK   cloudfunctionRoot = ${cfCfg}`);
}

// ===== 1. JSON 解析 =====
console.log('--- JSON 校验 ---');
const privateConfig = path.join(PROJECT, 'project.private.config.json');
const jsons = [...all.filter((f) => f.endsWith('.json')), path.join(PROJECT, 'project.config.json'), ...(fs.existsSync(privateConfig) ? [privateConfig] : [])];
for (const f of jsons) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'));
    console.log(`  OK   ${path.relative(ROOT, f)}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${path.relative(ROOT, f)} -> ${e.message}`);
  }
}

// ===== 2. app.json pages 四件套 =====
console.log('\n--- 页面文件完整性 ---');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const pages = [
  ...appJson.pages,
  ...(appJson.subpackages || []).flatMap((s) =>
    s.pages.map((p) => `${s.root}/${p}`)),
];
for (const pg of pages) {
  // pg 已经是含文件名的完整相对路径，如 pages/index/index
  const dir = path.join(ROOT, pg);
  const missing = ['js', 'json', 'wxml', 'wxss'].filter(
    (ext) => !fs.existsSync(`${dir}.${ext}`),
  );
  if (missing.length) {
    fail += 1;
    console.log(`  FAIL ${pg} 缺少 ${missing.join(', ')}`);
  } else {
    console.log(`  OK   ${pg}`);
  }
}

// ===== 3. 页面 json 里的组件路径是否存在 =====
console.log('\n--- 组件引用校验 ---');
for (const pg of pages) {
  const cfgPath = `${path.join(ROOT, pg)}.json`;
  if (!fs.existsSync(cfgPath)) continue;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const comps = cfg.usingComponents || {};
  for (const [name, rel] of Object.entries(comps)) {
    // rel 形如 /components/x/index 或 ../y/index
    const base = rel.startsWith('/')
      ? path.join(ROOT, rel)
      : path.resolve(path.dirname(cfgPath), rel);
    if (fs.existsSync(`${base}.js`) && fs.existsSync(`${base}.wxml`)) {
      console.log(`  OK   ${pg} -> ${name}`);
    } else {
      fail += 1;
      console.log(`  FAIL ${pg} -> ${name} 找不到 ${rel}`);
    }
  }
}

// ===== 4. 云函数共享库同步检查 =====
console.log('\n--- 云函数 _shared 同步 ---');
const cfRoot = path.join(PROJECT, 'cloudfunctions');
if (fs.existsSync(path.join(cfRoot, '_shared'))) {
  fail += 1;
  console.log('  WARN cloudfunctions/_shared 仍然存在 —— 「上传并部署所有云函数」会把它当成云函数上传并报错，');
  console.log('       请把源目录移到 cloudfunctions 外面（本项目为 shared-lib/）');
}
const fns = fs.readdirSync(cfRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== '_shared')
  .map((d) => d.name);
for (const fn of fns) {
  const shared = path.join(cfRoot, fn, '_shared', 'index.js');
  if (fs.existsSync(shared)) {
    if (fs.readFileSync(shared, 'utf8') !== fs.readFileSync(path.join(PROJECT, 'shared-lib', 'index.js'), 'utf8')) {
      fail += 1;
      console.log(`  FAIL ${fn} 共享库已过期，请运行 sync-shared.js`);
      continue;
    }
    console.log(`  OK   ${fn}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${fn} 缺 _shared，请先跑 node scripts/sync-shared.js`);
  }
}

console.log('\n--- 图标与 JS 语法 ---');
for (const tab of appJson.tabBar.list) {
  for (const icon of [tab.iconPath, tab.selectedIconPath].filter(Boolean)) {
    if (!fs.existsSync(path.join(ROOT, icon))) { fail++; console.log(`  FAIL 图标不存在 ${icon}`); }
  }
}
const { spawnSync } = require('child_process');
for (const file of all.filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) { fail++; console.log(`  FAIL ${path.relative(PROJECT, file)} ${result.stderr}`); }
}
console.log(`\n===== ${fail === 0 ? '全部通过' : `${fail} 项失败`} =====`);
process.exit(fail === 0 ? 0 : 1);
