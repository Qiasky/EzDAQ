/**
 * 云函数④ alarmList —— 告警列表
 * 支持按状态/级别筛选，按创建时间倒序
 * 触发时机：pages/alarm/alarm
 *
 * ⚠️ 必须建复合索引：status + createdAt（降序）
 *    level + createdAt（降序）
 */
const {
  db, _, ok, fail, wxContext, ALARM_STATUS,
} = require('./_shared');

exports.main = async (event) => {
  const {
    status = ALARM_STATUS.PENDING,
    level = '',
    deviceId = '',
    page = 1,
    pageSize = 20,
  } = event || {};

  try {
    wxContext();
  } catch (e) {
    return fail(401, '请先登录');
  }

  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(Number(pageSize) || 20, 50));
  const skip = (p - 1) * size;

  // 构造条件
  const where = {};
  if (status && status !== 'all') where.status = status;
  if (level) where.level = level;
  if (deviceId) where.deviceId = deviceId;

  try {
    const res = await db.collection('alarms')
      .where(where)
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(size)
      .get();

    // 各状态计数（用于 tab 角标），只查当前 status 之外的两项
    const countOf = async (st) => {
      const c = await db.collection('alarms').where({ status: st }).count();
      return c.total || 0;
    };
    const [pending, ack] = await Promise.all([
      countOf(ALARM_STATUS.PENDING),
      countOf(ALARM_STATUS.ACK),
    ]);

    return ok({
      list: res.data.map((a) => ({
        _id: a._id,
        deviceId: a.deviceId,
        deviceName: a.deviceName || '',
        level: a.level,
        code: a.code,
        message: a.message,
        value: a.value,
        threshold: a.threshold,
        status: a.status,
        handlerName: a.handlerName || '',
        createdAt: a.createdAt,
        handledAt: a.handledAt || 0,
        note: a.note || '',
      })),
      counts: { pending, ack },
      hasMore: res.data.length === size,
      page: p,
    });
  } catch (e) {
    console.error('[alarmList] 查询失败', e);
    // 复合索引未建时这里会报错，给出可操作的提示
    if (String(e.errMsg || '').includes('index')) {
      return fail(500, '数据库索引未建立，请控制台配置复合索引');
    }
    return fail(500, '告警数据读取失败');
  }
};
