/**
 * 云函数② deviceList —— 设备列表（含汇总统计）
 * 首页总览用，一次返回列表 + 统计，避免多次调用
 * 触发时机：pages/index/index
 */
const {
  db, ok, fail, wxContext, currentUser,
  computeStatus, DEVICE_STATUS,
} = require('./_shared');

exports.main = async (event) => {
  const { status, keyword, limit = 100 } = event || {};

  // MVP 阶段不做权限隔离，仅验证登录
  try {
    wxContext();
  } catch (e) {
    return fail(401, '请先登录');
  }

  const now = Date.now();

  // 构造查询条件
  const where = {};
  if (keyword) {
    where.name = db.RegExp({
      regexp: String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      options: 'i',
    });
  }

  let list = [];
  try {
    const res = await db.collection('devices')
      .where(where)
      .limit(Math.min(Number(limit) || 100, 100)) // 集合查询单次上限 100
      .get();
    list = res.data;
  } catch (e) {
    console.error('[deviceList] 查询失败', e);
    return fail(500, '设备数据读取失败');
  }

  // 计算实时状态 + 组装返回值
  const devices = list.map((d) => {
    const st = computeStatus(d, now);
    return {
      deviceId: d.deviceId,
      name: d.name,
      type: d.type || 'other',
      site: d.site || '',
      status: st,
      metrics: d.metrics || {},
      metricQuality: d.metricQuality || {},
      lastReportTime: d.lastReportTime || 0,
      source: d.source || '',
    };
  });

  // 前端筛选：按状态过滤放在服务端做，减少传输量
  const filtered = status ? devices.filter((d) => d.status === status) : devices;

  // 汇总统计
  const summary = {
    total: devices.length,
    normal: 0,
    warn: 0,
    fault: 0,
    offline: 0,
    maintain: 0,
  };
  devices.forEach((d) => {
    if (summary[d.status] !== undefined) summary[d.status] += 1;
  });

  // 排序：故障 > 预警 > 离线 > 检修 > 正常，运维最关心的排最前
  const weight = {
    [DEVICE_STATUS.FAULT]: 0,
    [DEVICE_STATUS.WARN]: 1,
    [DEVICE_STATUS.OFFLINE]: 2,
    [DEVICE_STATUS.MAINT]: 3,
    [DEVICE_STATUS.NORMAL]: 4,
  };
  filtered.sort((a, b) => (weight[a.status] - weight[b.status]));

  return ok({ list: filtered, summary, serverTime: now });
};
