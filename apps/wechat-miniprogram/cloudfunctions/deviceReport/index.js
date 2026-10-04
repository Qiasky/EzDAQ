/**
 * 云函数⑥ deviceReport —— 设备数据上报（HTTP 访问服务）
 *
 * ★ 这是全系统唯一暴露在公网、且不做微信登录鉴权的云函数
 *   安全依赖：HMAC-SHA256 签名 + 时间戳防重放 + 频率节流
 *
 * ★★ 协议兼容原则：Modbus / OPC UA / MQTT 等协议由设备侧网关转换，
 *    云函数只认下面这一种 JSON。新增设备类型只改网关，不动本函数。
 *
 * 触发时机：设备侧工控机网关定时 POST（间隔 ≥ 30s）
 *
 * 网关侧调用示例（Python）：
 *   url = f"https://{env}.service.tcloudbase.com/deviceReport"
 *   sign = hmac.new(secret.encode(), f"{device_id}:{ts}".encode(), 'sha256').hexdigest()
 *   body = {"deviceId": ..., "timestamp": ts, "sign": sign, "metrics": {...}, "source": "modbus"}
 *   requests.post(url, json=body, timeout=5)
 */
const crypto = require('crypto');
const {
  db, _, ok, fail, computeStatus,
  REPORT_MIN_INTERVAL, ALARM_COOLDOWN, THRESHOLDS,
  DEVICE_STATUS, ALARM_LEVEL, ALARM_STATUS,
} = require('./_shared');

exports.main = async (event) => {
  // ===== HTTP 访问服务的参数在 event.body / event.queryStringParameters 里 =====
  const raw = event.body
    ? safeParse(event.body)
    : (event.queryStringParameters || event);

  if (!raw || typeof raw !== 'object') {
    return fail(400, '请求格式错误');
  }

  const { deviceId, timestamp, sign, metrics, source, metricQuality } = raw;
  const now = Date.now();

  // ===== 1. 参数校验 =====
  if (!deviceId) return fail(400, '缺少 deviceId');
  if (!timestamp) return fail(400, '缺少 timestamp');
  if (!sign) return fail(400, '缺少 sign');
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return fail(400, '缺少 metrics');

  // ===== 2. 时间戳防重放（±5 分钟窗口）=====
  // 拦掉重放攻击和客户端时钟严重不准的情况
  const ts = Number(timestamp);
  if (Number.isNaN(ts)) return fail(400, 'timestamp 非法');
  if (Math.abs(now - ts) > 5 * 60 * 1000) {
    return fail(400, '时间戳超窗，请校准网关时钟');
  }

  // ===== 3. 取设备密钥并验签 =====
  let device;
  try {
    const res = await db.collection('devices').where({ deviceId }).limit(1).get();
    device = res.data[0];
  } catch (e) {
    console.error('[deviceReport] 查询设备失败', e);
    return fail(500, '服务异常');
  }
  if (!device) return fail(404, '设备未注册');

  if (device.enabled === false) return fail(403, '设备已停用');

  const secret = device.secret;
  if (!secret) return fail(500, '设备未配置密钥');

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${deviceId}:${ts}`)
    .digest('hex');

  // 定长比较，防时序侧信道
  if (!safeEqual(expected, String(sign))) {
    console.warn(`[deviceReport] 验签失败 device=${deviceId}`);
    return fail(401, '签名错误');
  }

  // ===== 4. 频率节流 =====
  // 网关异常或被人为刷请求时，这一道能挡住云函数被刷爆
  const last = device.lastReportTime || 0;
  if (last && now - last < REPORT_MIN_INTERVAL) {
    return ok({ skipped: true, reason: '节流', nextIn: REPORT_MIN_INTERVAL - (now - last) });
  }

  // ===== 5. 写入最新状态（覆盖写，保持最新优先）=====
  const sanitized = sanitizeMetrics(metrics);
  if (!sanitized) return fail(400, '监控点包含无效数值，请检查采集参数');
  if (!Object.keys(sanitized).length) return fail(400, '没有有效的监控点数据');
  const quality = sanitizeQuality(metricQuality, sanitized);
  if (!quality) return fail(400, '监控点质量标记无效');
  const nextStatus = decideStatus(device, sanitized);

  try {
    await db.collection('devices').where({ deviceId }).update({
      data: {
        status: nextStatus,
        metrics: _.set(sanitized),
        metricQuality: _.set(quality),
        source: String(source || 'unknown').slice(0, 32), // 记录协议来源，便于排查
        lastReportTime: now,
        updatedAt: now,
      },
    });
  } catch (e) {
    console.error('[deviceReport] 更新设备失败', e);
    return fail(500, '写入失败');
  }

  // ===== 6. 告警判定 =====
  // 失败不影响上报结果：设备数据已落库，不能因为告警逻辑异常丢数据
  try {
    await evaluateAlarms(device, sanitized, nextStatus, now);
  } catch (e) {
    console.error('[deviceReport] 告警判定失败', e);
  }

  return ok({ received: true, status: nextStatus, serverTime: now });
};

// ===== ========== 内部工具 ==========

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

/** 定长字符串比较，避免时序侧信道 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

/**
 * 清洗上报指标
 * 只保留白名单键 + 强制转数字，防止写入脏数据撑爆文档
 */
function sanitizeMetrics(m) {
  const ALLOW = ['vibration', 'temp', 'humidity', 'current', 'voltage', 'pressure', 'rpm', 'flow', 's'];
  const out = {};
  for (const k of ALLOW) {
    if (m[k] !== undefined && m[k] !== null) {
      if (!['number', 'string'].includes(typeof m[k]) || (typeof m[k] === 'string' && !m[k].trim())) return null;
      const v = Number(m[k]);
      if (!Number.isFinite(v) || (k === 'humidity' && (v < 0 || v > 100))) return null;
      out[k] = v;
    }
  }
  return out;
}

function sanitizeQuality(value, metrics) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of Object.keys(value)) {
    if (key !== 'humidity' || value[key] !== 'invalid' || metrics[key] !== undefined) return null;
    out[key] = 'invalid';
  }
  return out;
}

/**
 * 根据指标决定设备状态
 * 检修中优先：不检修才做阈值判定
 */
function decideStatus(device, metrics) {
  if (device.maintainFlag === true) return DEVICE_STATUS.MAINT;

  const checks = [
    ['vibration', THRESHOLDS.vibration],
    ['temp', THRESHOLDS.temp],
    ['current', THRESHOLDS.current],
    ['pressure', THRESHOLDS.pressure],
  ];

  let worst = DEVICE_STATUS.NORMAL;
  for (let i = 0; i < checks.length; i += 1) {
    const [key, th] = checks[i];
    const v = metrics[key];
    if (v === undefined) continue;
    // pressure 用绝对偏差比较（阈值语义是"偏差"）
    const hit = th ? (key === 'pressure'
      ? Math.abs(v) >= th.fault
      : v >= th.fault) : false;
    if (hit) return DEVICE_STATUS.FAULT;
    const warned = th ? (key === 'pressure'
      ? Math.abs(v) >= th.warn
      : v >= th.warn) : false;
    if (warned) worst = DEVICE_STATUS.WARN;
  }
  return worst;
}

const METRIC_LABEL = {
  vibration: '振动', temp: '温度', current: '电流',
  voltage: '电压', pressure: '压力偏差', rpm: '转速', flow: '流量', s: '秒表',
};

const METRIC_UNIT = {
  vibration: 'mm/s', temp: '℃', current: 'A',
  voltage: 'V', pressure: 'MPa', rpm: 'rpm', flow: 'm³/h', s: 's',
};

/**
 * 告警判定与落库
 * 冷却机制：同设备同代码 10 分钟内不重复生成告警，避免刷屏
 */
async function evaluateAlarms(device, metrics, status, now) {
  const candidates = [];

  if (status === DEVICE_STATUS.FAULT || status === DEVICE_STATUS.WARN) {
    const level = status === DEVICE_STATUS.FAULT
      ? ALARM_LEVEL.CRITICAL
      : ALARM_LEVEL.WARN;

    const THRESHOLDS_MAP = {
      vibration: THRESHOLDS.vibration,
      temp: THRESHOLDS.temp,
      current: THRESHOLDS.current,
      pressure: THRESHOLDS.pressure,
    };

    Object.keys(THRESHOLDS_MAP).forEach((key) => {
      const v = metrics[key];
      const th = THRESHOLDS_MAP[key];
      if (v === undefined || !th) return;
      const hit = key === 'pressure'
        ? Math.abs(v) >= (status === DEVICE_STATUS.FAULT ? th.fault : th.warn)
        : v >= (status === DEVICE_STATUS.FAULT ? th.fault : th.warn);
      if (hit) {
        candidates.push({
          code: `${key.toUpperCase()}_${level.toUpperCase()}`,
          message: `${METRIC_LABEL[key] || key}${status === DEVICE_STATUS.FAULT ? '超限' : '偏高'}：`
            + `${v}${METRIC_UNIT[key] || ''}（阈值 ${status === DEVICE_STATUS.FAULT ? th.fault : th.warn}）`,
          value: v,
          threshold: status === DEVICE_STATUS.FAULT ? th.fault : th.warn,
        });
      }
    });

    // 设备超时未上报 → 离线告警
    const last = device.lastReportTime || 0;
    if (last && now - last > 90 * 1000) {
      candidates.push({
        code: 'DEVICE_OFFLINE',
        message: '设备离线，超过 90 秒未收到上报',
        value: null,
        threshold: null,
      });
    }
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];

    // 冷却检查：查该设备该代码的最近一条告警
    const recent = await db.collection('alarms')
      .where({ deviceId: device.deviceId, code: c.code })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (recent.data.length) {
      const lastOne = recent.data[0];
      const open = lastOne.status === ALARM_STATUS.PENDING
        || lastOne.status === ALARM_STATUS.ACK;
      // 未闭环的重复告警不新建（避免同一问题刷几十条）
      if (open) continue;
      if (now - (lastOne.createdAt || 0) < ALARM_COOLDOWN) continue;
    }

    await db.collection('alarms').add({
      data: {
        deviceId: device.deviceId,
        deviceName: device.name || '',
        level: status === DEVICE_STATUS.FAULT ? ALARM_LEVEL.CRITICAL : ALARM_LEVEL.WARN,
        code: c.code,
        message: c.message,
        value: c.value,
        threshold: c.threshold,
        status: ALARM_STATUS.PENDING,
        handlerOpenid: '',
        handlerName: '',
        createdAt: now,
        handledAt: 0,
        note: '',
      },
    });
  }
}
