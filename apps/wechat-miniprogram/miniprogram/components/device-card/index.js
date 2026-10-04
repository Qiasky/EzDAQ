// components/device-card/index.js
const fmt = require('../../utils/format');
const {
  DEVICE_STATUS_TEXT, DEVICE_TYPE_TEXT,
} = require('../../utils/constants');

/** 指标展示配置：key → 中文名 + 单位 + 小数位 */
const METRIC_CFG = [
  { key: 'vibration', label: '振动', unit: 'mm/s', digits: 1 },
  { key: 'temp', label: '温度', unit: '℃', digits: 0 },
  { key: 'current', label: '电流', unit: 'A', digits: 1 },
];

Component({
  properties: {
    device: {
      type: Object,
      value: {},
    },
  },

  data: {
    statusText: '',
    typeText: '',
    lastReport: '',
    metrics: [],   // 预处理好的指标数组，WXML 里只做渲染
  },

  observers: {
    'device': function rebuild(device) {
      if (!device || !device.deviceId) return;

      const m = device.metrics || {};
      const metrics = METRIC_CFG
        .filter((c) => m[c.key] !== undefined && m[c.key] !== null)
        .map((c) => ({
          key: c.key,
          label: c.label,
          value: fmt.num(m[c.key], c.digits),
          unit: c.unit,
          // 越限高亮：跟后端阈值保持一致的判断，仅用于视觉提示
          over: Number(m[c.key]) >= (c.key === 'temp' ? 75 : 4.5),
        }));

      this.setData({
        statusText: DEVICE_STATUS_TEXT[device.status] || '未知',
        typeText: DEVICE_TYPE_TEXT[device.type] || '其他',
        lastReport: fmt.fromNow(device.lastReportTime),
        metrics,
      });
    },
  },

  methods: {
    /** 点击卡片进入设备详情 —— 事件交给父页面处理，组件自己不做导航 */
    onTap() {
      this.triggerEvent('tap', { deviceId: this.data.device.deviceId });
    },
  },
});