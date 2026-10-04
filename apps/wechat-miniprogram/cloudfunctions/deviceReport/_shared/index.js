/**
 * 云函数共享库
 * 所有云函数的第一行都是 require('./_shared')
 * SDK 初始化在这里统一做，各云函数不需要重复写
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// ===== 枚举常量（必须与前端 utils/constants.js 严格一致）=====
const DEVICE_STATUS = {
  NORMAL: 'normal',
  WARN: 'warn',
  FAULT: 'fault',
  OFFLINE: 'offline',
  MAINT: 'maintain',
};

const ALARM_LEVEL = { INFO: 'info', WARN: 'warn', CRITICAL: 'critical' };
const ALARM_STATUS = { PENDING: 'pending', ACK: 'ack', DONE: 'done', IGNORE: 'ignore' };

/** 离线判定阈值（毫秒） */
const OFFLINE_THRESHOLD = 90 * 1000;

/** 上报最小间隔（毫秒），节流用 */
const REPORT_MIN_INTERVAL = 30 * 1000;

/** 告警冷却期（毫秒）：同一设备同一代码在此期内不重复告警 */
const ALARM_COOLDOWN = 10 * 60 * 1000;

/** 设备告警阈值 —— MVP 阶段先硬编码，正式上线挪到 config 集合 */
const THRESHOLDS = {
  vibration: { warn: 4.5, fault: 7.0 },   // mm/s
  temp: { warn: 75, fault: 90 },// ℃
  current: { warn: 85, fault: 100 },     // A
  pressure: { warn: 0.02, fault: 0.05 }, // MPa 偏差
};

const db = cloud.database();
const _ = db.command;

/** 统一成功响应 */
const ok = (data = null, msg = 'ok') => ({ code: 0, data, msg });

/** 统一失败响应 */
const fail = (code, msg) => ({ code, data: null, msg });

/**
 * 获取当前小程序用户身份
 * @returns {{openid: string, unionid: string, appid: string}}
 */
function wxContext() {
  const ctx = cloud.getWXContext();
  if (!ctx.OPENID) {
    throw new Error('unauthorized');
  }
  return ctx;
}

/**
 * 获取当前用户文档，找不到返回 null
 */
async function currentUser(openid) {
  const { data } = await db.collection('users')
    .where({ _openid: openid })
    .limit(1)
    .get();
  return data[0] || null;
}

/**
 * 计算设备实时状态
 * 规则：检修中 > 超时未上报（离线）> 显式故障 > 显式预警 > 正常
 * @param {object} device devices 集合文档
 * @param {number} [now]
 * @returns {string} status 枚举值
 */
function computeStatus(device, now = Date.now()) {
  if (!device) return DEVICE_STATUS.OFFLINE;
  // 检修中由人工设置，优先级高于自动判定
  if (device.maintainFlag === true) return DEVICE_STATUS.MAINT;
  const last = device.lastReportTime || 0;
  if (now - last > OFFLINE_THRESHOLD) return DEVICE_STATUS.OFFLINE;
  if (device.status === DEVICE_STATUS.FAULT) return DEVICE_STATUS.FAULT;
  if (device.status === DEVICE_STATUS.WARN) return DEVICE_STATUS.WARN;
  return DEVICE_STATUS.NORMAL;
}

module.exports = {
  DEVICE_STATUS,
  ALARM_LEVEL,
  ALARM_STATUS,
  OFFLINE_THRESHOLD,
  REPORT_MIN_INTERVAL,
  ALARM_COOLDOWN,
  THRESHOLDS,
  db,
  _,
  ok,
  fail,
  wxContext,
  currentUser,
  computeStatus,
};
