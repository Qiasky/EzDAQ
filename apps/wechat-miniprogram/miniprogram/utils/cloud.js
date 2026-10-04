const { ENV_LIST, REQUEST_TIMEOUT } = require('../config');
const pending = new Map();
const cache = new Map();
let generation = 0;
function once(name, data) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud) return reject(new Error('当前基础库不支持云开发'));
    const timer = setTimeout(() => reject(new Error('云服务请求超时，请重试')), REQUEST_TIMEOUT);
    wx.cloud.callFunction({
      name, data, config: { env: ENV_LIST[0] },
      success(res) {
        clearTimeout(timer);
        const result = res.result;
        if (result && result.code === 0) resolve(result.data);
        else reject(Object.assign(new Error((result && result.msg) || '云服务返回异常'), { business: true }));
      },
      fail(err) {
        clearTimeout(timer);
        const message = String(err.errMsg || err.message || '');
        let hint;
        if (/Env.Not.Exists|100003|9001009/.test(message)) hint = '云环境不存在，请核对 config.js 中的环境 ID';
        else if (/collection.*(?:not exist|does not exist|not found)|(?:not exist|not found).*collection/i.test(message)) hint = '云数据库集合未初始化，请在云开发控制台运行 seedInit';
        else if (/FUNCTION_NOT_FOUND|FunctionName|function.*(?:not found|not exist)/i.test(message)) hint = `云函数 ${name} 尚未部署，请右键该函数目录上传并部署`;
        else hint = `云函数 ${name} 调用失败：${message.slice(0, 180) || '请检查网络及云函数运行日志'}`;
        reject(Object.assign(new Error(hint), { cloudFunction: name, code: err.errCode }));
      },
    });
  });
}
function call(name, data = {}, opts = {}) {
  const key = `${generation}:${name}:${JSON.stringify(data)}`;
  if (pending.has(key)) return pending.get(key);
  const hit = cache.get(key);
  if (opts.cache && hit && Date.now() - hit.time < 15000) return Promise.resolve(hit.data);
  // 重试直接调用 once，避免从 pending 读到自身而卡死。
  const promise = (async () => {
    for (let attempt = 0; ; attempt++) {
      try { const result = await once(name, data); if (opts.cache) cache.set(key, { data: result, time: Date.now() }); return result; }
      catch (error) { if (error.business || attempt >= (opts.retry || 0)) throw error; }
    }
  })().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}
function clearCache() { generation++; cache.clear(); }
function toastErr(err) { wx.showToast({ title: err.message || '操作失败', icon: 'none', duration: 2500 }); }
module.exports = { call, clearCache, toastErr, ENV_LIST };
