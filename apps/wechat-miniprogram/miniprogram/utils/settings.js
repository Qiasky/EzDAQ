const config = require('../config');
const KEY = 'ezdaq.connection.v1';
const MODES = { demo: '演示数据', cloud: '微信云开发', ezdaq: 'EzDAQ 平台' };
function get() {
  const saved = wx.getStorageSync(KEY) || {};
  return { mode: MODES[saved.mode] ? saved.mode : config.DEFAULT_MODE, baseUrl: saved.baseUrl || config.API_BASE_URL, env: config.ENV_LIST[0] };
}
function save(value) {
  if (!MODES[value.mode]) throw new Error('请选择数据来源');
  const baseUrl = String(value.baseUrl || config.API_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(baseUrl)) throw new Error('请输入完整的 HTTP / HTTPS 平台地址');
  // 仅连接偏好落盘；身份、令牌和真实设备数据不写入本地存储。
  wx.setStorageSync(KEY, { mode: value.mode, baseUrl });
  return get();
}
function info() { const value = get(); return { ...value, label: MODES[value.mode], isDemo: value.mode === 'demo' }; }
module.exports = { get, save, info, MODES };
