const api = require('../../services/api');
const view = require('../../utils/view-model');
const settings = require('../../utils/settings');
const scan = require('../../utils/scan');
const fmt = require('../../utils/format');
Page({
  data: { loading: true, error: '', alarmError: '', devices: [], list: [], summary: { total: 0, normal: 0, warn: 0, fault: 0, offline: 0 }, filter: '', keyword: '', site: '全部区域', siteName: '', pendingCount: 0, activeCount: 0, onlineRate: '--', updateText: '--', source: {}, filters: [{ key: '', label: '全部' }, { key: 'fault', label: '故障' }, { key: 'warn', label: '预警' }, { key: 'offline', label: '离线' }, { key: 'normal', label: '正常' }] },
  onShow() { this.loadData(); },
  onPullDownRefresh() { this.loadData().finally(() => wx.stopPullDownRefresh()); },
  async loadData() {
    const id = this._requestId = (this._requestId || 0) + 1;
    const connection = getApp().globalData.connectionVersion;
    const changed = this._connection !== connection;
    this._connection = connection;
    this.setData({ loading: true, error: '', alarmError: '', source: settings.info(), ...(changed ? { devices: [], list: [], filter: '', site: '全部区域', keyword: '', summary: { total: 0, normal: 0, warn: 0, fault: 0, offline: 0 }, pendingCount: 0, activeCount: 0, onlineRate: '--', updateText: '--', siteName: '' } : {}) });
    const [deviceResult, alarmResult] = await Promise.allSettled([api.devices(), api.alarms({ pageSize: 1 })]);
    if (id !== this._requestId || connection !== getApp().globalData.connectionVersion) return;
    if (deviceResult.status === 'fulfilled') {
      const result = deviceResult.value;
      const devices = result.list.map(view.device);
      const summary = result.summary || view.summary(devices);
      this.setData({ devices, summary, siteName: result.site || '设备监控现场', onlineRate: summary.total ? Math.round((summary.total - summary.offline) / summary.total * 100) : '--', updateText: fmt.datetime(result.serverTime).split(' ').pop(), loading: false });
      this.applyFilter();
    } else this.setData({ loading: false, error: deviceResult.reason.message });
    if (alarmResult.status === 'fulfilled') {
      const counts = alarmResult.value.counts;
      this.setData({ pendingCount: counts.pending, activeCount: counts.pending + counts.ack });
      if (counts.pending) wx.setTabBarBadge({ index: 1, text: String(counts.pending) });
      else wx.removeTabBarBadge({ index: 1 });
    } else this.setData({ alarmError: '告警统计暂不可用，请在告警中心重试', pendingCount: 0, activeCount: 0 });
  },
  applyFilter() {
    const { devices, filter, keyword, site } = this.data;
    const search = keyword.trim().toLowerCase();
    const weight = { fault: 0, warn: 1, offline: 2, maintain: 3, normal: 4 };
    const list = devices.filter(item => (!filter || item.status === filter) && (site === '全部区域' || item.site === site) && (!search || `${item.name} ${item.deviceId} ${item.site}`.toLowerCase().includes(search))).sort((a, b) => weight[a.status] - weight[b.status]);
    this.setData({ list });
  },
  onFilterTap(event) { this.setData({ filter: event.currentTarget.dataset.key }); this.applyFilter(); },
  onSearch(event) { this.setData({ keyword: event.detail.value }); this.applyFilter(); },
  onSite() {
    const sites = ['全部区域', ...new Set(this.data.devices.map(item => item.site).filter(Boolean))];
    wx.showActionSheet({ itemList: sites.slice(0, 6), success: result => { this.setData({ site: sites[result.tapIndex] }); this.applyFilter(); } });
  },
  onDeviceTap(event) { scan.open(event.currentTarget.dataset.id); },
  onScan() { scan.scan(); },
  onAlarm() { wx.switchTab({ url: '/pages/alarm/alarm' }); },
  onSettings() { wx.switchTab({ url: '/pages/mine/mine' }); },
  onRetry() { this.loadData(); },
  onShareAppMessage() { return { title: `EzDAQ 设备巡检 · ${this.data.source.label}`, path: '/pages/index/index' }; },
});
