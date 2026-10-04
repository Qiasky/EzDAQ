/**
 * 云函数③ deviceDetail —— 设备详情
 * 同时返回该设备的告警历史（最近 10 条）
 * 触发时机：pages/device/device
 */
const {
  db, _, ok, fail, wxContext, computeStatus, ALARM_STATUS,
} = require('./_shared');

exports.main = async (event) => {
  const { deviceId } = event || {};
  if (!deviceId) return fail(400, '缺少设备 ID');

  try {
    wxContext();
  } catch (e) {
    return fail(401, '请先登录');
  }

  const now = Date.now();

  // 查设备
  const devRes = await db.collection('devices')
    .where({ deviceId })
    .limit(1)
    .get();
  if (!devRes.data.length) return fail(404, '设备不存在');
  const d = devRes.data[0];

  // 查该设备最近告警（依赖索引：deviceId + createdAt）
  let alarms = [];
  try {
    const alRes = await db.collection('alarms')
      .where({ deviceId })
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    alarms = alRes.data
      .filter((a) => a.status !== ALARM_STATUS.IGNORE)
      .slice(0, 10);
  } catch (e) {
    // 告警查询失败不阻断详情展示
    console.error('[deviceDetail] 告警查询失败', e);
  }

  return ok({
    device: {
      deviceId: d.deviceId,
      name: d.name,
      type: d.type || 'other',
      model: d.model || '',
      site: d.site || '',
      vendor: d.vendor || '',
      installDate: d.installDate || 0,
      status: computeStatus(d, now),
      metrics: d.metrics || {},
      metricQuality: d.metricQuality || {},
      lastReportTime: d.lastReportTime || 0,
      maintainFlag: d.maintainFlag === true,
      source: d.source || '',
    },
    alarms: alarms.map((a) => ({
      _id: a._id,
      level: a.level,
      code: a.code,
      message: a.message,
      status: a.status,
      createdAt: a.createdAt,
      handledAt: a.handledAt || 0,
      note: a.note || '',
    })),
    serverTime: now,
  });
};
