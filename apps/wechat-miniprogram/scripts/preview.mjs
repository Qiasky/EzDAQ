// Source-backed browser preview. It runs the actual Page JS and WXML subset,
// but does not replace WeChat DevTools or native-device verification.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.EZDAQ_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'ezdaq-mobile-preview-'));
const { createServer } = await import('../../center-platform/server.mjs');
const platform = await createServer();
await new Promise(resolve => platform.listen(0, '127.0.0.1', resolve));
const apiBase = `http://127.0.0.1:${platform.address().port}`;
async function sources(dir, result = {}) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await sources(file, result);
    else if (/\.(js|json|wxml|wxss)$/.test(item.name)) result[path.relative(path.join(root, 'miniprogram'), file).replaceAll('\\', '/')] = await readFile(file, 'utf8');
  }
  return result;
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/sources') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(await sources(path.join(root, 'miniprogram'))));
    }
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const upstream = await fetch(apiBase + url.pathname + url.search, { method: req.method, headers: { 'content-type': 'application/json' }, ...(req.method !== 'GET' ? { body: Buffer.concat(chunks) } : {}) });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      return res.end(await upstream.text());
    }
    const relative = url.pathname === '/' ? 'preview/index.html' : url.pathname.startsWith('/assets/') ? `miniprogram${url.pathname}` : url.pathname.slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    const content = await readFile(file);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(file)] || 'text/plain';
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' }); res.end(content);
  } catch (error) { res.writeHead(404); res.end(error.message); }
});
const port = Number(process.env.PREVIEW_PORT || 18081);
server.listen(port, '127.0.0.1', () => console.log(`EzDAQ WeChat source preview: http://127.0.0.1:${port}`));
function stop() { server.close(); platform.close(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
