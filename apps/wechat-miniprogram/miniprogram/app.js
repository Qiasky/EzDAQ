const settings = require('./utils/settings');
const api = require('./services/api');
App({
  globalData: { userInfo: null, openid: null, accessToken: '', connectionVersion: 0 },
  onLaunch() {
    if (wx.cloud) wx.cloud.init({ env: settings.get().env, traceUser: true });
  },
  ensureLogin() {
    if (settings.get().mode !== 'cloud') return Promise.resolve(null);
    if (this.globalData.openid) return Promise.resolve(this.globalData.openid);
    if (!this._login) {
      const version = this.globalData.connectionVersion;
      const request = api.call('login').then(data => {
        if (version !== this.globalData.connectionVersion) throw new Error('数据来源已切换，请重新加载');
        this.globalData.openid = data.openid;
        this.globalData.userInfo = data.user;
        return data.openid;
      }).finally(() => { if (this._login === request) this._login = null; });
      this._login = request;
    }
    return this._login;
  },
  resetConnection(token = '') {
    this._login = null;
    this.globalData.openid = null;
    this.globalData.userInfo = null;
    this.globalData.accessToken = token;
    this.globalData.connectionVersion += 1;
    api.clearCache();
  },
});
