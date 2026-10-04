/**
 * 云函数⑤ alarmHandle —— 告警处理
 * 支持：认领（ack）/ 闭环（done）/ 忽略（ignore）
 * 触发时机：pages/alarm/alarm 的操作按钮
 */
const {
  db, ok, fail, wxContext, currentUser,
  ALARM_STATUS,
} = require('./_shared');

/** 允许的状态流转 —— 已闭环/已忽略的是终态，不可再变 */
const ALLOWED_TRANSITIONS = {
  [ALARM_STATUS.PENDING]: [ALARM_STATUS.ACK, ALARM_STATUS.DONE, ALARM_STATUS.IGNORE],
  [ALARM_STATUS.ACK]: [ALARM_STATUS.DONE, ALARM_STATUS.IGNORE],
  [ALARM_STATUS.DONE]: [],
  [ALARM_STATUS.IGNORE]: [],
};

exports.main = async (event) => {
  const { alarmId, action, note = '' } = event || {};
  if (!alarmId) return fail(400, '缺少告警 ID');
  if (!action) return fail(400, '缺少操作类型');
  if (action === 'done' && !String(note).trim()) return fail(400, '请填写处理说明');

  let ctx;
  try {
    ctx = wxContext();
  } catch (e) {
    return fail(401, '请先登录');
  }

  // doc().get() 查不到会抛异常，需 catch
  let alarm = null;
  try {
    const res = await db.collection('alarms').doc(alarmId).get();
    alarm = res.data;
  } catch (e) {
    return fail(404, '告警不存在');
  }
  if (!alarm) return fail(404, '告警不存在');

  // 校验状态流转合法性
  const allowed = ALLOWED_TRANSITIONS[alarm.status] || [];
  if (allowed.indexOf(action) === -1) {
    return fail(400, '当前状态不允许此操作');
  }

  const user = await currentUser(ctx.OPENID);
  if (!user || !['operator', 'admin'].includes(user.role)) return fail(403, '当前账号为只读权限，请由管理员设置巡检员角色');
  const now = Date.now();

  try {
    const result = await db.collection('alarms').where({ _id: alarmId, status: alarm.status }).update({
      data: {
        status: action,
        handlerOpenid: ctx.OPENID,
        handlerName: (user && user.nickname) || '未命名用户',
        handledAt: now,
        note: String(note).slice(0, 500), // 限长，防超长文本
      },
    });
    if (!result.stats.updated) return fail(409, '告警已由其他人员处理，请刷新');
  } catch (e) {
    console.error('[alarmHandle] 更新失败', e);
    return fail(500, '操作失败，请重试');
  }

  // 处置状态与物理状态分开；人工闭环不覆盖网关报告的故障值。

  return ok({ alarmId, status: action, handledAt: now });
};
