const api = require('../../services/api');
const view = require('../../utils/view-model');
const scan = require('../../utils/scan');
const settings = require('../../utils/settings');
const fmt = require('../../utils/format');
Page({
  data: { loading: true, error: '', source: {}, device: null, metrics: [], alarms: [], numericMetrics: [], selectedMetric: '', chartLoading: false, chartError: '', chartCaption: '', chartPoints: [], chartMin: '--', chartMax: '--', chartUnit: '' },
  onLoad(options) { try { this._deviceId = scan.deviceId(options); } catch (error) { this.setData({ loading: false, error: error.message }); } },
  onShow() { this.setData({ source: settings.info() }); if (this._deviceId) this.loadData(); },
  onReady() { this._ready = true; this.drawChart(); },
  onPullDownRefresh() { (this._deviceId ? this.loadData() : Promise.resolve()).finally(() => wx.stopPullDownRefresh()); },
  async loadData() {
    const id = this._requestId = (this._requestId || 0) + 1;
    const connection = getApp().globalData.connectionVersion;
    this.setData({ loading: true, error: '' });
    try {
      const result = await api.detail(this._deviceId);
      if (id !== this._requestId || connection !== getApp().globalData.connectionVersion) return;
      const metrics = view.metrics(result.device);
      const numericMetrics = metrics.filter(item => item.numeric);
      const selectedMetric = numericMetrics.some(item => item.key === this.data.selectedMetric) ? this.data.selectedMetric : numericMetrics.length ? numericMetrics[0].key : '';
      this.setData({ device: view.device(result.device), metrics, numericMetrics, selectedMetric, alarms: (result.alarms || result.recentAlarms || []).map(view.alarm), loading: false });
      if (selectedMetric && result.device.status !== 'offline') this.loadHistory(selectedMetric);
      else this.setData({ chartPoints: [], chartCaption: result.device.status === 'offline' ? '设备离线，暂无有效实时趋势' : '该设备暂无数值监控点' });
    } catch (error) { if (id === this._requestId) this.setData({ loading: false, error: error.message, device: null }); }
  },
  onMetric(event) { this.setData({ selectedMetric: event.currentTarget.dataset.key }); this.loadHistory(this.data.selectedMetric); },
  async loadHistory(key) {
    const id = this._chartRequest = (this._chartRequest || 0) + 1;
    const connection = getApp().globalData.connectionVersion;
    const metric = this.data.numericMetrics.find(item => item.key === key);
    this.setData({ chartLoading: true, chartError: '', chartPoints: [], chartMin: '--', chartMax: '--', chartUnit: metric ? metric.unit : '' });
    try {
      const result = await api.history(this._deviceId, key);
      if (id !== this._chartRequest || connection !== getApp().globalData.connectionVersion) return;
      const points = (result.points || []).filter(point => Number.isFinite(point.value));
      const values = points.map(point => point.value);
      this.setData({ chartLoading: false, chartPoints: points, chartCaption: result.caption || '历史趋势', chartMin: points.length ? fmt.num(Math.min(...values), metric.digits) : '--', chartMax: points.length ? fmt.num(Math.max(...values), metric.digits) : '--' }, () => this.drawChart());
    } catch (error) { if (id === this._chartRequest) this.setData({ chartLoading: false, chartError: error.message }); }
  },
  drawChart() {
    if (!this._ready || !this.data.chartPoints.length) return;
    wx.createSelectorQuery().in(this).select('#trendCanvas').fields({ node: true, size: true }).exec(result => {
      if (!result[0] || !this.data.chartPoints.length) return;
      const { node, width, height } = result[0];
      const ratio = wx.getWindowInfo().pixelRatio || 1;
      node.width = width * ratio; node.height = height * ratio;
      const ctx = node.getContext('2d'); ctx.scale(ratio, ratio);
      const values = this.data.chartPoints.map(point => point.value);
      const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
      const left = 10, top = 14, bottom = height - 25;
      const points = values.map((value, index) => [left + index / Math.max(values.length - 1, 1) * (width - left * 2), bottom - 12 - (value - min) / range * (bottom - top - 20)]);
      ctx.strokeStyle = '#e8efed'; ctx.lineWidth = 1;
      [top, (top + bottom) / 2, bottom].forEach(y => { ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - left, y); ctx.stroke(); });
      const gradient = ctx.createLinearGradient(0, top, 0, bottom); gradient.addColorStop(0, '#cbe8df'); gradient.addColorStop(1, '#ffffff');
      ctx.beginPath(); ctx.moveTo(points[0][0], bottom); points.forEach(point => ctx.lineTo(...point)); ctx.lineTo(points[points.length - 1][0], bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
      ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(...point) : ctx.moveTo(...point)); ctx.strokeStyle = '#228d7c'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.fillStyle = '#96a6ac'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(this.data.chartPoints[0].label, left, height - 5); ctx.textAlign = 'right'; ctx.fillText(this.data.chartPoints[values.length - 1].label, width - left, height - 5);
    });
  },
  onRetry() { if (this._deviceId) this.loadData(); else scan.scan(); },
  onAlarm() { wx.switchTab({ url: '/pages/alarm/alarm' }); },
  onSettings() { wx.switchTab({ url: '/pages/mine/mine' }); },
  onShareAppMessage() { return { title: this.data.device ? `EzDAQ · ${this.data.device.name} · ${this.data.device.statusText}` : 'EzDAQ 设备巡检', path: `/pages/device/device?deviceId=${encodeURIComponent(this._deviceId || '')}` }; },
});
