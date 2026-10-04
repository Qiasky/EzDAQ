const api = require('../../services/api');
const view = require('../../utils/view-model');
const settings = require('../../utils/settings');
const scan = require('../../utils/scan');
const { toastErr } = require('../../utils/cloud');
Page({
  data: { source: {}, list: [], counts: { pending: 0, ack: 0 }, loading: true, loadingMore: false, error: '', moreError: '', status: 'pending', level: '', levelText: '所有级别', page: 0, hasMore: false, handling: '', expanded: '', tabs: [{ key: 'pending', label: '待处理' }, { key: 'ack', label: '处理中' }, { key: 'done', label: '已闭环' }, { key: 'all', label: '全部' }] },
  onShow() {
    const version = getApp().globalData.connectionVersion;
    this.setData({ source: settings.info(), ...(this._connection !== version ? { counts: { pending: 0, ack: 0 } } : {}) });
    this._connection = version;
    this.loadData(true);
  },
  onPullDownRefresh() { this.loadData(true).finally(() => wx.stopPullDownRefresh()); },
  async loadData(reset = false) {
    const id = this._requestId = (this._requestId || 0) + 1;
    const connection = getApp().globalData.connectionVersion;
    const page = reset ? 1 : this.data.page + 1;
    this.setData(reset ? { loading: true, list: [], error: '', moreError: '', page: 0, hasMore: false, loadingMore: false } : { loadingMore: true, moreError: '' });
    try {
      const result = await api.alarms({ status: this.data.status, level: this.data.level, page });
      if (id !== this._requestId || connection !== getApp().globalData.connectionVersion) return;
      const decorated = result.list.map(view.alarm);
      const merged = reset ? decorated : this.data.list.concat(decorated);
      this.setData({ list: merged.filter((item, index) => merged.findIndex(other => other._id === item._id) === index), counts: result.counts, page, hasMore: result.hasMore, loading: false, loadingMore: false });
      if (result.counts.pending) wx.setTabBarBadge({ index: 1, text: String(result.counts.pending) }); else wx.removeTabBarBadge({ index: 1 });
    } catch (error) {
      if (id !== this._requestId) return;
      this.setData({ loading: false, loadingMore: false, ...(reset ? { error: error.message } : { moreError: error.message }) });
    }
  },
  onTab(event) { this.setData({ status: event.currentTarget.dataset.key, expanded: '' }); this.loadData(true); },
  onLevel() { const choices = ['所有级别', '紧急', '预警', '提示']; wx.showActionSheet({ itemList: choices, success: result => { this.setData({ level: ['', 'critical', 'warn', 'info'][result.tapIndex], levelText: choices[result.tapIndex] }); this.loadData(true); } }); },
  onReachBottom() { if (this.data.hasMore && !this.data.loadingMore && !this.data.loading) this.loadData(); },
  onRetry() { this.loadData(true); },
  onMore() { if (!this.data.loadingMore) this.loadData(); },
  onExpand(event) { const id = event.currentTarget.dataset.id; this.setData({ expanded: this.data.expanded === id ? '' : id }); },
  onDevice(event) { scan.open(event.currentTarget.dataset.id); },
  onSettings() { wx.switchTab({ url: '/pages/mine/mine' }); },
  onHandle(event) {
    if (this.data.handling) return;
    const { id, action } = event.currentTarget.dataset;
    if (action === 'ack') return this.doHandle(id, action, '');
    wx.showModal({ title: '完成告警处置', content: '', editable: true, placeholderText: '填写现场处理与复测结果（必填）', confirmText: '确认闭环', confirmColor: '#177c70', success: result => { if (!result.confirm) return; const note = String(result.content || '').trim(); if (!note) return wx.showToast({ title: '请填写处理说明', icon: 'none' }); this.doHandle(id, action, note); } });
  },
  async doHandle(id, action, note) {
    if (this.data.handling) return;
    this.setData({ handling: id });
    try { await api.handle(id, action, note); wx.showToast({ title: action === 'ack' ? '已认领告警' : '已完成闭环', icon: 'success' }); await this.loadData(true); }
    catch (error) { toastErr(error); }
    finally { this.setData({ handling: '' }); }
  },
});
