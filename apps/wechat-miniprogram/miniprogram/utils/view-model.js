const { DEVICE_STATUS_TEXT, DEVICE_TYPE_TEXT, ALARM_STATUS_TEXT } = require('./constants');
const fmt = require('./format');
const METRICS = {
  temp: { label: '温度', unit: '℃', digits: 1 }, humidity: { label: '湿度', unit: '%RH', digits: 1 },
  battery: { label: '电池容量', unit: '%', digits: 0 }, vibration: { label: '振动', unit: 'mm/s', digits: 1 },
  current: { label: '电流', unit: 'A', digits: 1 }, voltage: { label: '电压', unit: 'V', digits: 0 },
  pressure: { label: '压力偏差', unit: 'MPa', digits: 3 }, rpm: { label: '转速', unit: 'rpm', digits: 0 },
  door: { label: '门禁状态', unit: '', digits: 0 }, input: { label: '输入状态', unit: '', digits: 0 },
};
function metrics(device) {
  const values = device.metrics || {}, quality = device.metricQuality || {};
  const keys = Object.keys(values).concat(Object.keys(quality).filter(key => !(key in values)));
  return keys.filter(key => METRICS[key]).map(key => {
    if (quality[key] === 'invalid') return { key, ...METRICS[key], value: '无效', unit: '', numeric: false, tone: 'warn', caption: '采样无效，请检查探头' };
    const value = values[key];
    return { key, ...METRICS[key], value: Number.isFinite(value) ? fmt.num(value, METRICS[key].digits) : String(value == null ? '--' : value), numeric: Number.isFinite(value), tone: device.status };
  });
}
function device(item) {
  return { ...item, statusText: DEVICE_STATUS_TEXT[item.status] || '未知', typeText: DEVICE_TYPE_TEXT[item.type] || '设备', metricsView: metrics(item).slice(0, 3), lastReportText: fmt.fromNow(item.lastReportTime), sourceText: ({ modbus: 'Modbus TCP', tcp: 'TCP/IP', opcua: 'OPC UA', visa: 'VISA' })[item.source] || item.source || '未提供' };
}
function alarm(item) {
  return { ...item, levelText: ({ critical: '紧急', warn: '预警', info: '提示' })[item.level] || '提示', statusText: ALARM_STATUS_TEXT[item.status] || item.status, timeText: fmt.fromNow(item.createdAt), fullTime: fmt.datetime(item.createdAt), handledTime: item.handledAt ? fmt.datetime(item.handledAt) : '', valueText: item.value == null ? '' : String(item.value) + (item.unit || ''), thresholdText: item.threshold == null ? '' : String(item.threshold) + (item.unit || '') };
}
function summary(list) {
  const result = { total: list.length, normal: 0, warn: 0, fault: 0, offline: 0, maintain: 0 };
  list.forEach(item => { if (result[item.status] !== undefined) result[item.status]++; });
  return result;
}
function counts(list) {
  const result = { pending: 0, ack: 0, done: 0, ignore: 0 };
  list.forEach(item => { if (result[item.status] !== undefined) result[item.status]++; });
  return result;
}
module.exports = { device, alarm, metrics, summary, counts, METRICS };
