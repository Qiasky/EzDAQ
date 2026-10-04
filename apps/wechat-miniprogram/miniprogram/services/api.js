const settings = require('../utils/settings');
const cloud = require('../utils/cloud');
const demo = require('./demo');
const view = require('../utils/view-model');
const { REQUEST_TIMEOUT } = require('../config');
const pending = new Map();
function request(endpoint, method = 'GET', data) {
  const config = settings.get();
  const key = `${getApp().globalData.connectionVersion}:${config.baseUrl}:${endpoint}`;
  if (method === 'GET' && pending.has(key)) return pending.get(key);
  const promise = new Promise((resolve, reject) => {
    const token = getApp().globalData.accessToken;
    wx.request({ url: config.baseUrl + endpoint, method, data, timeout: REQUEST_TIMEOUT,
      header: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else reject(new Error((res.data && (res.data.message || res.data.error)) || `平台请求失败（${res.statusCode}）`));
      },
      fail() { reject(new Error('无法连接 EzDAQ，请检查平台地址、网络及合法域名配置')); },
    });
  }).finally(() => pending.delete(key));
  if (method === 'GET') pending.set(key, promise);
  return promise;
}
function normalizeDevice(item, time) {
  const values = {};
  ['humidity', 'battery', 'current', 'voltage', 'vibration', 'pressure', 'rpm', 'input'].forEach(key => { if (item[key] != null) values[key] = item[key]; });
  if (item.temperature != null) values.temp = item.temperature;
  if (item.category === '安保' && item.status) values.door = item.status;
  const status = !item.online ? 'offline' : item.battery != null && item.battery < 40 ? 'fault' : item.temperature != null && item.temperature >= 28 ? 'warn' : 'normal';
  return { deviceId: item.id, name: item.name, type: ({ 环境: 'sensor', 动力: 'power', 安保: 'other' })[item.category] || 'other', site: item.room || '', status, metrics: values, lastReportTime: time, source: '', model: '', snapshotOnly: true };
}
function normalizeAlarm(item, devices = []) {
  const device = devices.find(d => d.deviceId === item.deviceId);
  return { _id: item.id, deviceId: item.deviceId, deviceName: device ? device.name : item.deviceId, message: item.title, detail: item.detail, level: ({ 紧急: 'critical', 严重: 'warn', 一般: 'info' })[item.level] || 'info', status: ({ 待确认: 'pending', 处理中: 'ack', 已关闭: 'done', 已恢复: 'done' })[item.status] || 'pending', createdAt: Date.parse(item.openedAt), handledAt: item.closedAt ? Date.parse(item.closedAt) : 0, note: item.note || '' };
}
async function platformDevices() {
  const [devices, dashboard] = await Promise.all([request('/api/devices'), request('/api/dashboard')]);
  const time = Date.parse(dashboard.updatedAt) || Date.now();
  return { list: devices.items.map(item => normalizeDevice(item, time)), site: dashboard.site, serverTime: time };
}
async function devices() {
  const mode = settings.get().mode;
  if (mode === 'cloud') { await getApp().ensureLogin(); return { ...await cloud.call('deviceList', {}, { retry: 1 }), site: '设备监控现场' }; }
  if (mode === 'ezdaq') return platformDevices();
  const state = demo.get();
  return { list: state.devices, summary: view.summary(state.devices), site: state.site, serverTime: state.serverTime };
}
async function alarms(params = {}) {
  const { status = 'all', level = '', page = 1, pageSize = 20, deviceId = '' } = params;
  const mode = settings.get().mode;
  if (mode === 'cloud') { await getApp().ensureLogin(); return cloud.call('alarmList', { status, level, page, pageSize, deviceId }, { retry: 1 }); }
  let all;
  if (mode === 'demo') all = demo.get().alarms;
  else { const [result, deviceResult] = await Promise.all([request('/api/alerts'), platformDevices()]); all = result.items.map(item => normalizeAlarm(item, deviceResult.list)); }
  const list = all.filter(item => (status === 'all' || item.status === status) && (!level || item.level === level) && (!deviceId || item.deviceId === deviceId)).sort((a, b) => b.createdAt - a.createdAt);
  return { list: list.slice((page - 1) * pageSize, page * pageSize), counts: view.counts(all), hasMore: list.length > page * pageSize, page };
}
async function detail(deviceId) {
  if (settings.get().mode === 'cloud') { await getApp().ensureLogin(); return cloud.call('deviceDetail', { deviceId }, { retry: 1 }); }
  const [result, alarmResult] = await Promise.all([devices(), alarms({ deviceId, pageSize: 50 })]);
  const device = result.list.find(item => item.deviceId === deviceId);
  if (!device) throw new Error('设备不存在，请检查二维码或设备编号');
  return { device, alarms: alarmResult.list, serverTime: result.serverTime };
}
async function handle(alarmId, action, note = '') {
  if (!['ack', 'done', 'ignore'].includes(action)) throw new Error('不支持的告警操作');
  if (action === 'done' && !note.trim()) throw new Error('请填写处理说明');
  const mode = settings.get().mode;
  if (mode === 'demo') return demo.handle(alarmId, action, note);
  if (mode === 'cloud') { await getApp().ensureLogin(); return cloud.call('alarmHandle', { alarmId, action, note }); }
  if (action === 'ignore') throw new Error('当前 EzDAQ 接口不支持忽略告警');
  return request(`/api/alerts/${encodeURIComponent(alarmId)}/${action === 'done' ? 'close' : 'ack'}`, 'POST', { note });
}
async function history(deviceId, key) {
  const mode = settings.get().mode;
  if (mode === 'demo') return { ...demo.history(deviceId, key), caption: '24 小时演示趋势' };
  if (mode === 'cloud') return { points: [], caption: '当前云函数仅提供实时值，暂无历史采样' };
  if (deviceId !== 'temp-01' || key !== 'temp') return { points: [], caption: '当前平台仅提供温度传感器历史接口' };
  return { ...await request('/api/history'), caption: '平台模拟温度趋势 · 24 小时' };
}
async function testConnection(config, token = '') {
  if (config.mode === 'demo') return '演示模式已就绪';
  if (config.mode === 'cloud') {
    await cloud.call('login');
    const [devices] = await Promise.all([
      cloud.call('deviceList'),
      cloud.call('alarmList', { status: 'all', page: 1, pageSize: 1 }),
    ]);
    return devices.list.length ? `云连接成功，已读取 ${devices.list.length} 台设备` : '云连接成功，设备台账为空；可先运行 seedInit 初始化测试台账';
  }
  const result = await new Promise((resolve, reject) => wx.request({ url: config.baseUrl.replace(/\/+$/, '') + '/api/health', timeout: REQUEST_TIMEOUT, header: token ? { Authorization: `Bearer ${token}` } : {}, success: res => res.statusCode === 200 ? resolve(res.data) : reject(new Error(`接口返回 ${res.statusCode}`)), fail: () => reject(new Error('连接失败，请核对平台地址与合法域名')) }));
  if (result.status !== 'ok') throw new Error('平台健康检查未通过');
  return `EzDAQ ${result.version || ''} 连接成功`;
}
function clearCache() { cloud.clearCache(); }
module.exports = { devices, alarms, detail, handle, history, testConnection, clearCache, call: cloud.call, normalizeDevice, normalizeAlarm };
