const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../miniprogram');
const compiler = process.argv[2] || 'D:/Program Files (x86)/Tencent/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
function files(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const file = path.join(directory, item.name);
    return item.isDirectory() ? files(file, extension) : file.endsWith(extension) ? [path.relative(root, file)] : [];
  });
}
for (const [binary, extension] of [['wcc', '.wxml'], ['wcsc', '.wxss']]) {
  const result = spawnSync(path.join(compiler, binary + '.exe'), ['-o', path.join(os.tmpdir(), `ezdaq-mobile-${binary}.js`), ...files(root, extension)], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    console.error(result.error ? '找不到微信原生编译器，可传入编译器目录：node scripts/check-native.cjs "编译器目录"' : result.stderr || result.stdout);
    process.exit(1);
  }
}
console.log('微信原生 WXML / WXSS 编译通过');
