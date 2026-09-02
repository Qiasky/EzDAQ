import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = process.env.EZDAQ_DATA_DIR || path.join(root, 'data');
const statePath = path.join(dataDir, 'state.json');
const port = Number(process.env.PORT || 8080);

const initialState = () => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  devices: [
    { id: 'temp-01', name: '温湿度传感器-01', category: '环境', room: '机房 A', online: true, temperature: 29.6, humidity: 51, unit: '℃' },
    { id: 'ups-01', name: 'UPS-01', category: '动力', room: '机房 A', online: true, battery: 37, input: '正常', unit: '%' },
    { id: 'door-01', name: '门禁-01', category: '安保', room: '机房 A', online: true, status: '关闭' },
    { id: 'fan-01', name: '新风机-01', category: '环境', room: '机房 A', online: false, status: '通讯中断' }
  ],
  alerts: [
    { id: 'A-0003', level: '紧急', title: 'UPS-01 电池容量过低', detail: '当前 37%，低于阈值 40%', deviceId: 'ups-01', status: '待确认', openedAt: new Date().toISOString(), note: '' },
    { id: 'A-0002', level: '严重', title: '机房 A 温度偏高', detail: '当前 29.6℃，阈值 28℃', deviceId: 'temp-01', status: '处理中', openedAt: new Date().toISOString(), note: '' },
    { id: 'A-0001', level: '一般', title: '新风机通讯中断', detail: '设备已离线', deviceId: 'fan-01', status: '待确认', openedAt: new Date().toISOString(), note: '' }
  ],
  events: []
});

let state = initialState();
async function load() { if (existsSync(statePath)) state = JSON.parse(await readFile(statePath, 'utf8')); else await save(); }
async function save() { state.updatedAt = new Date().toISOString(); await mkdir(dataDir, { recursive: true }); await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8'); }
function event(type, text) { state.events.unshift({ id: crypto.randomUUID(), type, text, at: new Date().toISOString() }); state.events = state.events.slice(0, 30); }
function activeAlerts() { return state.alerts.filter(a => !['已恢复', '已关闭'].includes(a.status)); }
function dashboard() {
  const temp = state.devices.find(d => d.id === 'temp-01'); const ups = state.devices.find(d => d.id === 'ups-01');
  return { site: '上海 · 浦东数据中心', online: state.devices.filter(d => d.online).length, total: state.devices.length, activeAlerts: activeAlerts().length, temperature: temp.temperature, humidity: temp.humidity, battery: ups.battery, updatedAt: state.updatedAt };
}
function json(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(payload)); }
function notFound(res) { json(res, 404, { error: 'NOT_FOUND' }); }
async function body(req) { let raw = ''; for await (const part of req) raw += part; return raw ? JSON.parse(raw) : {}; }
async function serveStatic(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(publicDir, file);
  if (!target.startsWith(publicDir) || !existsSync(target) || (await stat(target)).isDirectory()) return false;
  const mime = target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'text/html';
  res.writeHead(200, { 'content-type': `${mime}; charset=utf-8` }); res.end(await readFile(target)); return true;
}
async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`); const { pathname } = url;
    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { status: 'ok', version: '0.1.0', updatedAt: state.updatedAt });
    if (req.method === 'GET' && pathname === '/api/dashboard') return json(res, 200, dashboard());
    if (req.method === 'GET' && pathname === '/api/devices') return json(res, 200, { items: state.devices });
    if (req.method === 'GET' && pathname === '/api/alerts') return json(res, 200, { items: state.alerts });
    if (req.method === 'GET' && pathname === '/api/events') return json(res, 200, { items: state.events });
    if (req.method === 'GET' && pathname === '/api/history') {
      const temp = state.devices.find(d => d.id === 'temp-01').temperature;
      const points = Array.from({ length: 24 }, (_, i) => ({ label: `${String(i).padStart(2, '0')}:00`, value: +(temp - 2.5 + Math.sin(i / 3) * 1.5 + (i === 23 ? 0 : Math.random())).toFixed(1) }));
      return json(res, 200, { point: 'temperature', unit: '℃', points });
    }
    if (req.method === 'POST' && pathname === '/api/simulate') {
      const temp = state.devices.find(d => d.id === 'temp-01'); const ups = state.devices.find(d => d.id === 'ups-01');
      temp.temperature = +Math.max(22, Math.min(33, temp.temperature + Math.random() * 3 - 1)).toFixed(1); temp.humidity = Math.round(43 + Math.random() * 18); ups.battery = Math.max(20, ups.battery - Math.floor(Math.random() * 3));
      const temperatureAlert = state.alerts.find(a => a.id === 'A-SIM-TEMP');
      if (temp.temperature >= 28 && !temperatureAlert) state.alerts.unshift({ id: 'A-SIM-TEMP', level: temp.temperature > 30 ? '紧急' : '严重', title: '机房 A 温度阈值告警', detail: `当前 ${temp.temperature}℃，阈值 28℃`, deviceId: temp.id, status: '待确认', openedAt: new Date().toISOString(), note: '' });
      if (temp.temperature < 27.5 && temperatureAlert) temperatureAlert.status = '已恢复';
      event('采集', `模拟采集：温度 ${temp.temperature}℃，湿度 ${temp.humidity}%RH，UPS 电池 ${ups.battery}%。`); await save(); return json(res, 200, dashboard());
    }
    const action = pathname.match(/^\/api\/alerts\/([^/]+)\/(ack|close)$/);
    if (req.method === 'POST' && action) {
      const alert = state.alerts.find(a => a.id === decodeURIComponent(action[1])); if (!alert) return notFound(res);
      const input = await body(req);
      if (action[2] === 'ack') alert.status = '处理中';
      if (action[2] === 'close') { alert.status = '已关闭'; alert.note = String(input.note || '').trim() || '运维人员已处理'; alert.closedAt = new Date().toISOString(); }
      event('告警', `${alert.id} ${action[2] === 'ack' ? '已确认' : '已关闭'}。`); await save(); return json(res, 200, { item: alert });
    }
    if (pathname.startsWith('/api/')) return notFound(res);
    if (await serveStatic(res, pathname)) return; notFound(res);
  } catch (error) { json(res, 500, { error: 'INTERNAL_ERROR', message: error.message }); }
}

export async function createServer() { await load(); return http.createServer(handler); }
if (process.argv[1] === fileURLToPath(import.meta.url)) { const server = await createServer(); server.listen(port, () => console.log(`EzDAQ EPS MVP 0.1.0: http://localhost:${port}`)); }
