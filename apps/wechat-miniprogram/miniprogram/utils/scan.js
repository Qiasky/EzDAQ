function decode(value) { try { return decodeURIComponent(value || ''); } catch (_) { throw new Error('二维码内容格式错误'); } }
function deviceId(input) {
  if (typeof input === 'string') {
    const text = decode(input).trim();
    if (/^https?:\/\//.test(text) || text.includes('?')) {
      const query = text.match(/[?&](?:deviceId|scene)=([^&#]+)/);
      if (query) return deviceId(decode(query[1]));
      if (/^https?:\/\//.test(text)) return deviceId(text.replace(/[?#].*$/, '').split('/').pop());
      throw new Error('二维码不含设备编号');
    }
    if (/^[\w\u4e00-\u9fa5.-]{1,64}$/.test(text)) return text;
    throw new Error('二维码不含有效设备编号');
  }
  return deviceId((input && (input.deviceId || input.scene || input.q || input.path || input.result)) || '');
}
function open(id) { wx.navigateTo({ url: `/pages/device/device?deviceId=${encodeURIComponent(id)}` }); }
function scan() {
  wx.scanCode({ onlyFromCamera: false, success: res => { try { open(deviceId(res)); } catch (error) { wx.showToast({ title: error.message, icon: 'none' }); } }, fail: error => { if (!/cancel/i.test(error.errMsg || '')) wx.showToast({ title: '扫码失败，请重试', icon: 'none' }); } });
}
module.exports = { deviceId, scan, open };
