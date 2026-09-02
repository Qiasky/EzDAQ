import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.EZDAQ_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'ezdaq-test-'));
const { createServer } = await import('../server.mjs');
const server = await createServer();
await new Promise(resolve => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const request = (url, options) => fetch(base + url, options).then(async r => ({ status:r.status, body:await r.json() }));

test('health and dashboard are available', async () => { const health=await request('/api/health'); const dashboard=await request('/api/dashboard'); assert.equal(health.status,200); assert.equal(health.body.version,'0.1.0'); assert.equal(dashboard.body.site,'上海 · 浦东数据中心'); });
test('simulation produces a valid dashboard snapshot', async () => { const result=await request('/api/simulate',{method:'POST'}); assert.equal(result.status,200); assert.ok(result.body.temperature >= 22 && result.body.temperature <= 33); assert.ok(result.body.battery >= 20); });
test('alert acknowledgement and closure are persisted through the API', async () => { const list=await request('/api/alerts'); const alert=list.body.items.find(a=>a.status==='待确认'); const ack=await request(`/api/alerts/${alert.id}/ack`,{method:'POST'}); assert.equal(ack.body.item.status,'处理中'); const close=await request(`/api/alerts/${alert.id}/close`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note:'自动化验证'})}); assert.equal(close.body.item.status,'已关闭'); assert.equal(close.body.item.note,'自动化验证'); });
test.after(() => server.close());
