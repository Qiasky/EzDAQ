const settings = require('../../utils/settings');
const api = require('../../services/api');
const demo = require('../../services/demo');
const { toastErr } = require('../../utils/cloud');
const scan = require('../../utils/scan');
Page({
  data: { source: {}, name: '现场工程师', settingsOpen: false, helpOpen: false, mode: 'demo', baseUrl: '', token: '', saving: false, connectionMessage: '', connectionError: '', modes: [{ key: 'demo', label: '演示数据', desc: '无需配置，体验完整界面' }, { key: 'cloud', label: '微信云开发', desc: '沿用已配置的云环境与云函数' }, { key: 'ezdaq', label: 'EzDAQ 平台', desc: '连接已有中心平台 HTTP 接口' }] },
  onShow() {
    const source = settings.info();
    const user = getApp().globalData.userInfo;
    this.setData({ source, mode: source.mode, baseUrl: source.baseUrl, name: user && user.nickname ? user.nickname : source.isDemo ? '演示工程师' : '现场工程师', token: getApp().globalData.accessToken || '' });
  },
  onPullDownRefresh() { this.onShow(); wx.stopPullDownRefresh(); },
  onConnection() { this.setData({ settingsOpen: !this.data.settingsOpen, connectionError: '', connectionMessage: '' }); },
  onHelp() { this.setData({ helpOpen: !this.data.helpOpen }); },
  onMode(event) { this.setData({ mode: event.currentTarget.dataset.key, connectionError: '', connectionMessage: '' }); },
  onUrl(event) { this.setData({ baseUrl: event.detail.value }); },
  onToken(event) { this.setData({ token: event.detail.value }); },
  async onTest() {
    if (this.data.saving) return;
    this.setData({ saving: true, connectionError: '', connectionMessage: '' });
    try { this.setData({ connectionMessage: await api.testConnection({ mode: this.data.mode, baseUrl: this.data.baseUrl }, this.data.token) }); }
    catch (error) { this.setData({ connectionError: error.message }); }
    finally { this.setData({ saving: false }); }
  },
  async onSave() {
    if (this.data.saving) return;
    this.setData({ saving: true, connectionError: '', connectionMessage: '' });
    try {
      const baseUrl = this.data.baseUrl.trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(baseUrl)) throw new Error('请输入完整的平台地址');
      await api.testConnection({ mode: this.data.mode, baseUrl }, this.data.token);
      settings.save({ mode: this.data.mode, baseUrl });
      getApp().resetConnection(this.data.mode === 'ezdaq' ? this.data.token : '');
      this.setData({ source: settings.info(), connectionMessage: '连接已保存，返回总览即可查看', name: this.data.mode === 'demo' ? '演示工程师' : '现场工程师' });
      wx.showToast({ title: '连接已保存', icon: 'success' });
    } catch (error) { this.setData({ connectionError: error.message }); }
    finally { this.setData({ saving: false }); }
  },
  onScan() { scan.scan(); },
  onAlarm() { wx.switchTab({ url: '/pages/alarm/alarm' }); },
  onResetDemo() { demo.reset(); wx.showToast({ title: '演示数据已恢复', icon: 'success' }); },
  onRefresh() { getApp().resetConnection(); this.setData({ token: '' }); wx.showToast({ title: '已重置，返回总览刷新', icon: 'none' }); },
  onAbout() { wx.showModal({ title: 'EzDAQ EPS 设备巡检', content: '版本 0.2.0\n现场设备监控与告警处置\n\n采集网关 → 平台 / 云开发 → 微信小程序\n\n演示模式的数据与趋势用于界面验收。', showCancel: false }); },
  onShareAppMessage() { return { title: 'EzDAQ EPS · 设备状态与现场告警', path: '/pages/index/index' }; },
});
