const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../miniprogram');
let storage, app;
const get = name => require(path.join(root, name));
function page(name) {
  let definition;
  global.Page = value => { definition = value; };
  get(`pages/${name}/${name}.js`);
  return { ...definition, data: structuredClone(definition.data), setData(value, callback) { Object.assign(this.data, value); if (callback) callback(); } };
}
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
test.beforeEach(() => {
  Object.keys(require.cache).filter(key => key.startsWith(root)).forEach(key => delete require.cache[key]);
  storage = new Map();
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key,value) => storage.set(key,value),
    cloud: { init() {}, callFunction() { throw new Error('Unexpected cloud call in demo'); } },
    showToast() {}, setTabBarBadge() {}, removeTabBarBadge() {},
    request(options) {
      fetch(options.url, { method: options.method || 'GET', headers: options.header, signal: AbortSignal.timeout(options.timeout || 12000), ...(options.data ? { body: JSON.stringify(options.data) } : {}) })
        .then(async res => options.success({ statusCode: res.status, data: await res.json() })).catch(error => options.fail(error));
    },
  };
  global.getApp = () => app;
  global.App = definition => { app = definition; };
  get('app.js'); app.onLaunch();
});
test('demo completes alarm claim and closure with a persisted note without changing physical device status', async () => {
  const api = get('services/api');
  assert.equal((await api.devices()).list.length, 6);
  assert.equal((await api.alarms()).counts.pending, 2);
  await assert.rejects(api.handle('DEMO-A003','done',''), /处理说明/);
  await api.handle('DEMO-A003','ack');
  assert.equal((await api.alarms({status:'ack'})).counts.ack, 2);
  await api.handle('DEMO-A003','done','已更换电池，完成复测');
  const detail = await api.detail('UPS-A01');
  assert.equal(detail.alarms[0].note,'已更换电池，完成复测');
  assert.equal(detail.device.status,'fault');
  assert.equal((await api.history('UPS-A01','battery')).points.length,24);
  await assert.rejects(api.handle('DEMO-A003','ack'), /状态已变化/);
  assert.equal(storage.size,0, 'business records and identity must not be persisted to wx storage');
});
test('device QR parser supports direct IDs, scene, q links, and scan path, and rejects malformed input', () => {
  const scan = get('utils/scan');
  assert.equal(scan.deviceId('UPS-A01'),'UPS-A01');
  assert.equal(scan.deviceId({scene:'temp-01'}),'temp-01');
  assert.equal(scan.deviceId({q:encodeURIComponent('https://example.com/eq?deviceId=DEV001')}),'DEV001');
  assert.equal(scan.deviceId({path:'pages/device/device?scene=FAN-A01'}),'FAN-A01');
  assert.throws(()=>scan.deviceId('%E0%A4%A'), /格式错误/);
  assert.throws(()=>scan.deviceId({}), /设备编号/);
  assert.throws(()=>scan.deviceId('pages/index/index?foo=x'), /设备编号/);
});
test('cloud reads retry and deduplicate concurrent requests without a promise cycle', {timeout:2000}, async () => {
  let calls = 0;
  wx.cloud.callFunction = options => queueMicrotask(() => { calls++; if(calls === 1) options.fail({errMsg:'network error'}); else options.success({result:{code:0,data:{ok:true}}}); });
  const cloud = get('utils/cloud');
  const results = await Promise.all([cloud.call('deviceList',{}, {retry:1}), cloud.call('deviceList',{}, {retry:1})]);
  assert.equal(calls,2); assert.deepEqual(results,[{ok:true},{ok:true}]);
  calls = 0;
  wx.cloud.callFunction = options => queueMicrotask(() => { calls++; options.success({result:{code:403,msg:'无权限'}}); });
  await assert.rejects(cloud.call('alarmHandle',{}, {retry:2}), /无权限/);
  assert.equal(calls,1, 'business errors must not retry mutations');
});
test('concurrent cloud page entry shares one silent login', async () => {
  get('utils/settings').save({mode:'cloud',baseUrl:'http://localhost:18080'});
  let count = 0;
  wx.cloud.callFunction = options => { count++; queueMicrotask(()=>options.success({result:{code:0,data:{openid:'user-1',user:{nickname:'值班员'}}}})); };
  await Promise.all([app.ensureLogin(),app.ensureLogin()]);
  assert.equal(count,1); assert.equal(app.globalData.openid,'user-1');
});
test('cloud connection test verifies device and alarm reads, not only login', async () => {
  const calls=[];
  wx.cloud.callFunction = options => queueMicrotask(() => {
    calls.push(options.name);
    if (options.name==='deviceList') options.success({result:{code:0,data:{list:[{deviceId:'DEV001'}]}}});
    else options.success({result:{code:0,data:{list:[]}}});
  });
  const api=get('services/api');
  assert.match(await api.testConnection({mode:'cloud'}), /已读取 1 台设备/);
  assert.deepEqual(calls,['login','deviceList','alarmList']);
  wx.cloud.callFunction=options=>queueMicrotask(()=>options.name==='deviceList' ? options.fail({errMsg:'FUNCTION_NOT_FOUND: function not found'}) : options.success({result:{code:0,data:{list:[]}}}));
  await assert.rejects(api.testConnection({mode:'cloud'}), /deviceList.*尚未部署/);
});
test('missing cloud collections show initialization guidance and preserve the actual source', async () => {
  wx.cloud.callFunction=options=>queueMicrotask(()=>options.fail({errMsg:'database collection users does not exist',errCode:-1}));
  await assert.rejects(get('services/api').testConnection({mode:'cloud'}), /seedInit/);
  assert.equal(storage.size,0);
});
test('rapid alarm filtering ignores old responses and pagination failure retries the same page', async () => {
  const api = get('services/api'), first = deferred(), second = deferred();
  let calls = 0; api.alarms = () => (++calls === 1 ? first : second).promise;
  const instance = page('alarm');
  const oldLoad = instance.loadData(true); instance.data.status='ack'; const newLoad = instance.loadData(true);
  second.resolve({list:[{_id:'new',status:'ack',createdAt:Date.now()}],counts:{pending:0,ack:1},hasMore:true}); await newLoad;
  first.resolve({list:[{_id:'old',status:'pending',createdAt:Date.now()}],counts:{pending:1,ack:0},hasMore:false}); await oldLoad;
  assert.equal(instance.data.list[0]._id,'new'); assert.equal(instance.data.page,1);
  const requested=[]; api.alarms=async params=>{requested.push(params.page);throw new Error('网络中断')};
  await instance.loadData(); await instance.loadData();
  assert.deepEqual(requested,[2,2]); assert.equal(instance.data.page,1); assert.equal(instance.data.list.length,1);
});
test('device search combines keyword, area, and status while keeping all-site summary', async () => {
  const instance=page('index'); await instance.loadData();
  assert.equal(instance.data.list.length,6); assert.equal(instance.data.summary.total,6);
  instance.onSearch({detail:{value:'ups-a01'}}); assert.equal(instance.data.list.length,1);
  instance.onFilterTap({currentTarget:{dataset:{key:'normal'}}}); assert.equal(instance.data.list.length,0);
  assert.equal(instance.data.summary.total,6);
  instance.data.keyword='';instance.data.filter='';instance.data.site='动力站 · 循环水区';instance.applyFilter();assert.equal(instance.data.list[0].deviceId,'PUMP-A01');
});
test('invalid humidity renders an explanation, hides stale numbers, and is excluded from trend choices', () => {
  const view=get('utils/view-model');
  const readings=view.metrics({status:'normal',metrics:{temp:24.0625,humidity:55},metricQuality:{humidity:'invalid'}});
  assert.equal(readings[0].value,'24.1');
  assert.equal(readings[1].value,'无效');assert.equal(readings[1].numeric,false);
  assert.match(readings[1].caption,/检查探头/);assert.equal(readings[1].unit,'');
  assert.deepEqual(readings.filter(item=>item.numeric).map(item=>item.key),['temp']);
  assert.equal(view.metrics({metrics:{temp:24},metricQuality:{humidity:'invalid'}})[1].value,'无效');
  assert.equal(view.metrics({metrics:{temp:24,humidity:55.5},metricQuality:{}})[1].value,'55.5');
});
test('failed connection save keeps previous data source and never stores bearer tokens', async () => {
  const api=get('services/api');api.testConnection=async()=>{throw new Error('连接失败')};
  const instance=page('mine');instance.onShow();instance.data.mode='ezdaq';instance.data.baseUrl='https://example.com';instance.data.token='sensitive-token';
  await instance.onSave();assert.equal(get('utils/settings').get().mode,'demo');assert.match(instance.data.connectionError,/连接失败/);assert.equal(storage.size,0);
});
test('an old cloud login cannot restore identity after switching data sources', async () => {
  get('utils/settings').save({mode:'cloud',baseUrl:'http://localhost:18080'});
  const response=deferred();wx.cloud.callFunction=options=>response.promise.then(()=>options.success({result:{code:0,data:{openid:'old-identity',user:{nickname:'old'}}}}));
  const login=app.ensureLogin();app.resetConnection();response.resolve();
  await assert.rejects(login,/数据来源已切换/);assert.equal(app.globalData.openid,null);
});
test('native client adapter interoperates with actual EzDAQ platform endpoints', async () => {
  process.env.EZDAQ_DATA_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'ezdaq-mobile-test-'));
  const {createServer}=await import('../../center-platform/server.mjs');const server=await createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    get('utils/settings').save({mode:'ezdaq',baseUrl:base});app.resetConnection();
    const api=get('services/api');assert.match(await api.testConnection({mode:'ezdaq',baseUrl:base}),/连接成功/);
    const devices=await api.devices();assert.equal(devices.list.length,4);assert.equal(devices.list.find(d=>d.deviceId==='fan-01').status,'offline');
    const alarms=await api.alarms({status:'pending',pageSize:1});assert.equal(alarms.hasMore,true);
    const id=alarms.list[0]._id;await api.handle(id,'ack');await api.handle(id,'done','小程序联调处置完成');
    const closed=await api.alarms({status:'done'});assert.equal(closed.list.find(item=>item._id===id).note,'小程序联调处置完成');
    assert.equal((await api.history('temp-01','temp')).points.length,24);assert.equal((await api.history('ups-01','battery')).points.length,0);
    await assert.rejects(api.detail('nonexistent'),/设备不存在/);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
