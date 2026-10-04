// @ts-check
/**
 * 云函数共享库同步脚本
 *
 * ★ 为什么需要这个脚本：
 *   微信云开发上传云函数时，只上传函数自己的目录（xx/index.js、xx/package.json），
 *   不会带上共享库。所以每个云函数目录里必须有一份 _shared 副本。
 *
 * ★ 为什么源目录放在 cloudfunctions/ 外面（shared-lib/）：
 *   开发者工具的「上传并部署所有云函数」会遍历 cloudfunctions/ 下的每个子目录，
 *   源目录放在里面会被当成一个云函数尝试上传并报错。放在外面就干净了。
 *
 * 用法：node scripts/sync-shared.js
 * 执行时机：改了 shared-lib/index.js 之后，务必跑一次再上传云函数
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHARED = path.join(ROOT, 'shared-lib');
const CF_ROOT = path.join(ROOT, 'cloudfunctions');

// 需要同步的目标云函数
const TARGETS = [
  'login',
  'deviceList',
  'deviceDetail',
  'alarmList',
  'alarmHandle',
  'deviceReport',
  'seedInit',
];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, item.name);
    const d = path.join(dest, item.name);
    if (item.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(SHARED)) {
  console.error('✗ 找不到 _shared 目录：', SHARED);
  process.exit(1);
}

let done = 0;
for (const name of TARGETS) {
  const fnDir = path.join(CF_ROOT, name);
  if (!fs.existsSync(fnDir)) {
    console.warn(`! 跳过不存在的云函数目录：${name}`);
    continue;
  }
  const dest = path.join(fnDir, '_shared');
  const resolvedDest = path.resolve(dest);
  if (!resolvedDest.startsWith(path.resolve(CF_ROOT) + path.sep) || !resolvedDest.endsWith(path.sep + '_shared')) {
    throw new Error('共享副本路径不在本工程 cloudfunctions 内，拒绝清理');
  }
  // 清掉旧副本，避免残留已删除的文件
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  copyDir(SHARED, dest);
  console.log(`✓ ${name}/_shared`);
  done += 1;
}

// seedInit 需要一份测试设备数据，从 scripts/seed-devices.json 复制过去（保持单一数据源）
const SEED_SRC = path.join(ROOT, 'scripts', 'seed-devices.json');
const SEED_DEST = path.join(CF_ROOT, 'seedInit', 'devices_seed.json');

console.log(`完成：${done}/${TARGETS.length} 个云函数已同步 _shared`);

if (fs.existsSync(SEED_SRC) && fs.existsSync(path.join(CF_ROOT, 'seedInit'))) {
  fs.copyFileSync(SEED_SRC, SEED_DEST);
  console.log('✓ seedInit/devices_seed.json（来自 scripts/seed-devices.json）');
}
