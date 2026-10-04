/**
 * 云函数① login —— 登录初始化
 * 静默登录，不弹授权框。用户首次进入时自动建档
 * 触发时机：app.js onLaunch / 页面 ensureLogin
 */
const { db, ok, fail, wxContext } = require('./_shared');

exports.main = async () => {
  let ctx;
  try {
    ctx = wxContext();
  } catch (e) {
    return fail(401, '未授权');
  }

  const { OPENID, UNIONID, APPID } = ctx;
  const now = Date.now();

  // 查用户
  const exist = await db.collection('users').where({ _openid: OPENID }).limit(1).get();

  // 首次登录 → 建档
  if (!exist.data.length) {
    const user = {
      _openid: OPENID,
      unionid: UNIONID || '',
      appid: APPID,
      nickname: '',
      avatar: '',
      phone: '',
      role: 'viewer',// viewer 观察者 / operator 巡检员 / admin 管理员
      teamId: '',           // MVP 阶段不设班组
      createdAt: now,
      lastLoginAt: now,
    };
    try {
      await db.collection('users').add({ data: user });
    } catch (e) {
      // 并发首次登录可能重复插入，再查一次即可
      const again = await db.collection('users').where({ _openid: OPENID }).limit(1).get();
      return ok({ openid: OPENID, user: again.data[0] || user, isNew: false });
    }
    return ok({ openid: OPENID, user, isNew: true });
  }

  // 老用户 → 更新登录时间，不动业务字段
  const user = exist.data[0];
  await db.collection('users').where({ _openid: OPENID }).update({
    data: { lastLoginAt: now },
  });

  return ok({ openid: OPENID, user: { ...user, lastLoginAt: now }, isNew: false });
};