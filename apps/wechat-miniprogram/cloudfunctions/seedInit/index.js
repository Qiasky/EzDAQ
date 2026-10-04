/**
 * seedInit —— 一键初始化（仅用于搭建环境，不属于业务链路）
 *
 * 做两件事：
 *   1. 创建 devices / alarms / users 三个集合（已存在则跳过）
 *   2. devices 为空时，导入 scripts/seed-devices.json 里的测试设备
 *
 * 幂等：重复调用不会重复插入数据。
 * 上线前应删掉这个函数，或在 _shared 里加开关限制调用来源。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DEVICES = require('./devices_seed.json');

const COLLECTIONS = ['devices', 'alarms', 'users'];

exports.main = async (event) => {
  const created = {};

  // 1) 建集合 —— 已存在会抛错，忽略即可
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      created[name] = 'created';
    } catch (e) {
      created[name] = 'exists';
    }
  }

  // 2) 导数据 —— 只在 devices 为空时执行，保证幂等
  let devices;
  try {
    const { total } = await db.collection('devices').count();
    if (total > 0) {
      return {
        code: 0,
        msg: `集合中已有 ${total} 台设备，跳过导入`,
        data: { collections: created, inserted: 0, total },
      };
    }
  } catch (e) {
    return {
      code: -1,
      msg: `访问 devices 集合失败：${e.message}。集合刚创建时可能有短暂延迟，稍等几秒再试一次。`,
    };
  }

  devices = Array.isArray(DEVICES) ? DEVICES : DEVICES.data || [];

  try {
    await db.collection('devices').add({ data: devices });
  } catch (e) {
    return { code: -1, msg: `导入设备失败：${e.message}` };
  }

  return {
    code: 0,
    msg: `已导入 ${devices.length} 台测试设备`,
    data: { collections: created, inserted: devices.length, total: devices.length },
  };
};
