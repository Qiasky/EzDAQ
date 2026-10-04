/** 业务枚举与常量 —— 与云端 _shared/constants.js 保持一致 */

/** 设备状态 */
const DEVICE_STATUS = {
  NORMAL: 'normal',      // 正常
  WARN: 'warn',          // 预警
  FAULT: 'fault',        // 故障
  OFFLINE: 'offline',    // 离线（超阈值未上报）
  MAINT: 'maintain',     // 检修中
};

const DEVICE_STATUS_TEXT = {
  normal: '正常',
  warn: '预警',
  fault: '故障',
  offline: '离线',
  maintain: '检修',
};

/** 状态对应的语义色（与 app.wxss 变量对应） */
const DEVICE_STATUS_COLOR = {
  normal: 'var(--success)',
  warn: 'var(--warning)',
  fault: 'var(--danger)',
  offline: 'var(--text-hint)',
  maintain: 'var(--info)',
};

/** 告警级别 */
const ALARM_LEVEL = {
  INFO: 'info',
  WARN: 'warn',
  CRITICAL: 'critical',
};

const ALARM_LEVEL_TEXT = {
  info: '提示',
  warn: '预警',
  critical: '严重',
};

const ALARM_LEVEL_COLOR = {
  info: 'var(--info)',
  warn: 'var(--warning)',
  critical: 'var(--danger)',
};

/** 告警处理状态 */
const ALARM_STATUS = {
  PENDING: 'pending',    // 待处理
  ACK: 'ack',            // 已确认
  DONE: 'done',          // 已闭环
  IGNORE: 'ignore',      // 已忽略
};

const ALARM_STATUS_TEXT = {
  pending: '待处理',
  ack: '处理中',
  done: '已闭环',
  ignore: '已忽略',
};

/** 设备类型（网关统一转换后的标准类型） */
const DEVICE_TYPE = {
  PUMP: 'pump',          // 泵
  FAN: 'fan',            // 风机
  VALVE: 'valve',        // 阀门
  SENSOR: 'sensor',      // 传感器
  POWER: 'power',        // 配电
  VACUUM: 'vacuum',      // 真空
  OTHER: 'other',
};

const DEVICE_TYPE_TEXT = {
  pump: '泵',
  fan: '风机',
  valve: '阀门',
  sensor: '传感器',
  power: '配电',
  vacuum: '真空',
  other: '其他',
};

/** 离线判定阈值：超过 90 秒未上报视为离线 */
const OFFLINE_THRESHOLD = 90 * 1000;

/** 上报最小间隔：网关侧节流，防止刷云函数调用 */
const REPORT_MIN_INTERVAL = 30 * 1000;

module.exports = {
  DEVICE_STATUS,
  DEVICE_STATUS_TEXT,
  DEVICE_STATUS_COLOR,
  ALARM_LEVEL,
  ALARM_LEVEL_TEXT,
  ALARM_LEVEL_COLOR,
  ALARM_STATUS,
  ALARM_STATUS_TEXT,
  DEVICE_TYPE,
  DEVICE_TYPE_TEXT,
  OFFLINE_THRESHOLD,
  REPORT_MIN_INTERVAL,
};