/** 格式化工具 */

const pad = (n) => (n < 10 ? `0${n}` : `${n}`);

/** 2026-10-03 14:05 */
function datetime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 10-03 14:05 */
function shortTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 昨天 / 具体日期
 * 设备"最后上报时间"用这个，运维一眼能判断设备是否失联
 */
function fromNow(ts) {
  if (!ts) return '从未上报';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day} 天前`;
  return shortTime(ts);
}

/** 数值保留 n 位小数，非数字返回 '--' */
function num(v, n = 1) {
  if (v === null || v === undefined || v === '') return '--';
  const f = Number(v);
  if (Number.isNaN(f)) return '--';
  return f.toFixed(n);
}

/** 毫秒 → 时长：3h 25m */
function duration(ms) {
  if (!ms || ms < 0) return '--';
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

module.exports = { datetime, shortTime, fromNow, num, duration };