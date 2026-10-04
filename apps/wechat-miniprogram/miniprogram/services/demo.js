// 演示与真实数据完全分开；每页显示数据来源，操作仅影响内存演示记录。
let state;
function fresh() {
  const now = Date.now();
  return {
    devices: [
      { deviceId: 'UPS-A01', name: 'UPS 不间断电源', type: 'power', site: '机房 A · 配电区', model: 'UPS 30kVA', vendor: '示例设备', source: 'modbus', status: 'fault', metrics: { battery: 37, voltage: 220, current: 18.6 }, lastReportTime: now - 18000 },
      { deviceId: 'TH-A01', name: '温湿度传感器', type: 'sensor', site: '机房 A · 冷通道', model: 'TH-200', source: 'modbus', status: 'warn', metrics: { temp: 29.6, humidity: 51 }, lastReportTime: now - 12000 },
      { deviceId: 'FAN-A01', name: '精密空调新风机', type: 'fan', site: '机房 A · 空调区', model: 'FAN-750', source: 'tcp', status: 'offline', metrics: {}, lastReportTime: now - 15 * 60000 },
      { deviceId: 'PUMP-A01', name: '冷却循环泵', type: 'pump', site: '动力站 · 循环水区', model: 'CP-80', source: 'modbus', status: 'normal', metrics: { vibration: 2.1, current: 32.8, rpm: 1450 }, lastReportTime: now - 8000 },
      { deviceId: 'DOOR-A01', name: '机房门禁控制器', type: 'other', site: '机房 A · 主入口', model: 'AC-02', source: 'tcp', status: 'normal', metrics: { door: '关闭' }, lastReportTime: now - 10000 },
      { deviceId: 'PWR-A01', name: '智能配电柜', type: 'power', site: '动力站 · 配电区', model: 'PDU-3P', source: 'modbus', status: 'normal', metrics: { voltage: 380, current: 46.2 }, lastReportTime: now - 5000 },
    ],
    alarms: [
      { _id: 'DEMO-A003', deviceId: 'UPS-A01', deviceName: 'UPS 不间断电源', level: 'critical', code: 'BATTERY_LOW', message: 'UPS 电池容量低于安全阈值', value: 37, threshold: 40, unit: '%', status: 'pending', createdAt: now - 4 * 60000, note: '' },
      { _id: 'DEMO-A002', deviceId: 'TH-A01', deviceName: '温湿度传感器', level: 'warn', code: 'TEMP_HIGH', message: '冷通道温度持续偏高', value: 29.6, threshold: 28, unit: '℃', status: 'ack', handlerName: '值班工程师', createdAt: now - 23 * 60000, handledAt: now - 8 * 60000, note: '' },
      { _id: 'DEMO-A001', deviceId: 'FAN-A01', deviceName: '精密空调新风机', level: 'info', code: 'OFFLINE', message: '新风机通讯中断，请检查现场连接', status: 'pending', createdAt: now - 15 * 60000, note: '' },
      { _id: 'DEMO-A000', deviceId: 'PUMP-A01', deviceName: '冷却循环泵', level: 'warn', code: 'VIBRATION_HIGH', message: '循环泵振动预警已处理', value: 4.8, threshold: 4.5, unit: 'mm/s', status: 'done', createdAt: now - 120 * 60000, handledAt: now - 100 * 60000, handlerName: '值班工程师', note: '已检查联轴器并完成紧固，复测正常。' },
    ],
    site: '上海 · 浦东数据中心', serverTime: now,
  };
}
function get() { if (!state) state = fresh(); return JSON.parse(JSON.stringify(state)); }
function handle(id, action, note) {
  if (!state) state = fresh();
  const alarm = state.alarms.find(item => item._id === id);
  if (!alarm) throw new Error('告警不存在');
  const allowed = { pending: ['ack', 'done', 'ignore'], ack: ['done', 'ignore'] };
  if (!(allowed[alarm.status] || []).includes(action)) throw new Error('告警状态已变化，请刷新');
  if (action === 'done' && !String(note || '').trim()) throw new Error('请填写处理说明');
  Object.assign(alarm, { status: action, note: note || '', handlerName: '演示工程师', handledAt: Date.now() });
  return { alarmId: id, status: action };
}
function history(deviceId, key) {
  const device = get().devices.find(item => item.deviceId === deviceId);
  if (!device || !Number.isFinite(device.metrics[key])) return { points: [] };
  const value = device.metrics[key];
  return { points: Array.from({ length: 24 }, (_, index) => ({ label: `${String(index).padStart(2, '0')}:00`, value: +(value + Math.sin(index / 3) * Math.max(value * .04, .1)).toFixed(2) })) };
}
function reset() { state = fresh(); }
module.exports = { get, handle, history, reset };
