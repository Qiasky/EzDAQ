const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function load(file,dependency,modules={}) {
  const context={exports:{},module:{exports:{}},require:name=>modules[name]||dependency,console,Date,Buffer};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
  return Object.keys(context.exports).length ? context.exports : context.module.exports;
}
test('stale cloud telemetry overrides cached fault/warn status with offline',()=>{
  const shared=load('shared-lib/index.js',{init(){},database:()=>({command:{}})});
  const now=Date.now();
  assert.equal(shared.computeStatus({status:'warn',lastReportTime:now-100000},now),'offline');
  assert.equal(shared.computeStatus({status:'fault',lastReportTime:now-1000},now),'fault');
  assert.equal(shared.computeStatus({maintainFlag:true,lastReportTime:0},now),'maintain');
});
test('cloud alarm closure validates operator role, note, and concurrent status changes',async()=>{
  let role='viewer',updated=1,updates=0;
  const shared={
    db:{collection(name){assert.equal(name,'alarms','alarm closure must not change physical device telemetry');return {doc:()=>({get:async()=>({data:{_id:'a1',deviceId:'d1',status:'pending'}})}),where(condition){assert.equal(condition._id,'a1');assert.equal(condition.status,'pending');return {update:async()=>{updates++;return {stats:{updated}}}}}}}},
    ok:data=>({code:0,data}),fail:(code,msg)=>({code,msg}),wxContext:()=>({OPENID:'engineer'}),currentUser:async()=>({role,nickname:'测试巡检员'}),
    ALARM_STATUS:{PENDING:'pending',ACK:'ack',DONE:'done',IGNORE:'ignore'},
  };
  const fn=load('cloudfunctions/alarmHandle/index.js',shared);
  assert.equal((await fn.main({alarmId:'a1',action:'ack'})).code,403);assert.equal(updates,0);
  role='operator';assert.equal((await fn.main({alarmId:'a1',action:'done',note:''})).code,400);
  updated=0;assert.equal((await fn.main({alarmId:'a1',action:'ack'})).code,409);
  updated=1;assert.equal((await fn.main({alarmId:'a1',action:'done',note:'复测完成'})).code,0);
});

function sensorReporter() {
  const crypto=require('node:crypto');
  const updates=[];
  const replacements=[];
  const device={deviceId:'HOME-TH-001',name:'家庭温湿度传感器',secret:'local-test-secret',lastReportTime:0};
  const shared={
    _:{set(value){replacements.push(value);return value;}},
    db:{collection(name){assert.equal(name,'devices');return {where(){return {limit:()=>({get:async()=>({data:[device]})}),update:async({data})=>{updates.push(data);return {stats:{updated:1}}}}}}}},
    ok:data=>({code:0,data}),fail:(code,msg)=>({code,msg}),REPORT_MIN_INTERVAL:30000,ALARM_COOLDOWN:600000,
    THRESHOLDS:{temp:{warn:75,fault:90}},DEVICE_STATUS:{NORMAL:'normal',WARN:'warn',FAULT:'fault',MAINT:'maintain'},
    ALARM_LEVEL:{WARN:'warn',CRITICAL:'critical'},ALARM_STATUS:{PENDING:'pending',ACK:'ack'},
  };
  const fn=load('cloudfunctions/deviceReport/index.js',shared,{crypto});
  const request=(metrics,metricQuality)=>{
    const timestamp=Date.now();
    const sign=crypto.createHmac('sha256',device.secret).update(`${device.deviceId}:${timestamp}`).digest('hex');
    return {body:JSON.stringify({deviceId:device.deviceId,timestamp,sign,metrics,metricQuality,source:'modbus'})};
  };
  return {fn,updates,request,replacements};
}
test('signed sensor HTTP report preserves humidity and negative temperature with source',async()=>{
  const {fn,updates,request}=sensorReporter();
  const result=await fn.main(request({temp:-2.5,humidity:55.2,unknown:123}));
  assert.equal(result.code,0);assert.equal(result.data.received,true);
  assert.equal(updates.length,1);assert.equal(updates[0].metrics.temp,-2.5);
  assert.equal(updates[0].metrics.humidity,55.2);assert.equal(updates[0].metrics.unknown,undefined);
  assert.equal(updates[0].source,'modbus');
});
test('sensor reporting rejects invalid values and signatures before changing telemetry',async()=>{
  const {fn,updates,request}=sensorReporter();
  for (const metrics of [{temp:22,humidity:101},{temp:22,humidity:-1},{temp:'Infinity',humidity:50},{temp:'',humidity:50},{temp:true,humidity:50},{unknown:25}]) {
    assert.equal((await fn.main(request(metrics))).code,400);
  }
  const invalid=request({temp:22,humidity:50});
  const body=JSON.parse(invalid.body);body.sign='wrong';invalid.body=JSON.stringify(body);
  assert.equal((await fn.main(invalid)).code,401);
  assert.equal(updates.length,0);
  assert.equal((await fn.main(request({temp:0,humidity:0}))).code,0);
  assert.equal(updates[0].metrics.temp,0);assert.equal(updates[0].metrics.humidity,0);
});
test('partial sensor report replaces old humidity with invalid quality and clears it on recovery',async()=>{
  const {fn,updates,request,replacements}=sensorReporter();
  assert.equal((await fn.main(request({temp:24.0625},{humidity:'invalid'}))).code,0);
  assert.equal(updates[0].metrics.humidity,undefined);
  assert.equal(updates[0].metricQuality.humidity,'invalid');
  assert.equal(replacements[0],updates[0].metrics);
  assert.equal(replacements[1],updates[0].metricQuality);
  assert.equal((await fn.main(request({temp:24.1,humidity:55.5}))).code,0);
  assert.equal(updates[1].metrics.humidity,55.5);
  assert.equal(Object.keys(updates[1].metricQuality).length,0);
  assert.equal(replacements[3],updates[1].metricQuality);
});
test('quality flags cannot conflict with a numeric humidity value or bypass telemetry validation',async()=>{
  const {fn,updates,request}=sensorReporter();
  for(const [metrics,quality] of [[{temp:24,humidity:55},{humidity:'invalid'}],[{temp:24},{humidity:'broken'}],[{temp:24},{temp:'invalid'}],[{temp:24},[]],[{}, {humidity:'invalid'}]]) {
    assert.equal((await fn.main(request(metrics,quality))).code,400);
  }
  assert.equal(updates.length,0);
});
test('list and detail preserve invalid humidity quality without exposing the device key',async()=>{
  const telemetry={deviceId:'HOME-TH-001',name:'家庭传感器',secret:'private-device-key',metrics:{temp:24.0625},metricQuality:{humidity:'invalid'}};
  const query={where(){return this;},limit(){return this;},orderBy(){return this;},get:async()=>({data:[telemetry]})};
  const empty={...query,get:async()=>({data:[]})};
  const shared={db:{collection:name=>name==='devices'?query:empty},ok:data=>({code:0,data}),fail:(code,msg)=>({code,msg}),wxContext:()=>({OPENID:'engineer'}),computeStatus:()=> 'normal',DEVICE_STATUS:{NORMAL:'normal'},ALARM_STATUS:{IGNORE:'ignore'}};
  const list=await load('cloudfunctions/deviceList/index.js',shared).main({});
  const detail=await load('cloudfunctions/deviceDetail/index.js',shared).main({deviceId:telemetry.deviceId});
  for(const record of [list.data.list[0],detail.data.device]) {
    assert.equal(record.metrics.temp,24.0625);assert.equal(record.metricQuality.humidity,'invalid');
    assert.equal(record.secret,undefined);
  }
});
