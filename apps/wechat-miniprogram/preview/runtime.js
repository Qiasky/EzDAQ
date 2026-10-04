/* A deliberately small development renderer for this project's WXML subset. */
(async () => {
  const sources = await fetch('/sources').then(response => response.json());
  const modules = {}, screen = document.querySelector('#screen'), tabbar = document.querySelector('#tabbar');
  let app, page, pageName, pageDefinition, stack = [], badge = '';
  function resolve(base, request) {
    const parts = (request.startsWith('/') ? request.slice(1) : base.split('/').slice(0,-1).join('/') + '/' + request).split('/');
    const clean = []; parts.forEach(part => { if (part === '..') clean.pop(); else if (part && part !== '.') clean.push(part); });
    const name = clean.join('/'); return name.endsWith('.js') ? name : name + '.js';
  }
  function requireModule(name) {
    if (modules[name]) return modules[name].exports;
    const module = { exports: {} }; modules[name] = module;
    if (!sources[name]) throw new Error('Missing module: ' + name);
    new Function('require','module','exports','wx','getApp','App','Page', sources[name])(request => requireModule(resolve(name, request)), module, module.exports, wx, () => app, value => { app = value; }, value => { pageDefinition = value; });
    return module.exports;
  }
  const scopeEval = (expression, scope) => new Function('scope', 'with(scope){return (' + expression + ')}')(scope);
  function interpolate(text, scope) {
    const exact = text.match(/^\s*\{\{([^{}]*?)\}\}\s*$/);
    if (exact) return scopeEval(exact[1], scope);
    return text.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => { const value = scopeEval(expression, scope); return value == null ? '' : value; });
  }
  function children(parent, scope) {
    const fragment = document.createDocumentFragment(); let branch = false;
    for (const child of parent.childNodes) {
      if (child.nodeType === 3) { const text = interpolate(child.textContent, scope); if (String(text).trim()) fragment.append(document.createTextNode(text)); continue; }
      if (child.nodeType !== 1) continue;
      if (child.hasAttribute('wx:if')) { branch = !!interpolate(child.getAttribute('wx:if'), scope); if (!branch) continue; }
      else if (child.hasAttribute('wx:elif')) { if (branch) continue; branch = !!interpolate(child.getAttribute('wx:elif'), scope); if (!branch) continue; }
      else if (child.hasAttribute('wx:else')) { if (branch) continue; branch = true; }
      else branch = false;
      if (child.hasAttribute('wx:for')) {
        const list = interpolate(child.getAttribute('wx:for'), scope) || [];
        list.forEach((item, index) => fragment.append(renderNode(child, { ...scope, [child.getAttribute('wx:for-item') || 'item']: item, [child.getAttribute('wx:for-index') || 'index']: index })));
      } else fragment.append(renderNode(child, scope));
    }
    return fragment;
  }
  function renderNode(node, scope) {
    if (node.tagName === 'block') return children(node, scope);
    const tag = ({ view:'div', text:'span', input:'input', button:'button', canvas:'canvas' })[node.tagName];
    if (!tag) throw new Error('Unsupported preview component: ' + node.tagName);
    const element = document.createElement(tag);
    for (const attribute of node.attributes) {
      const { name } = attribute; const value = interpolate(attribute.value, scope);
      if (name.startsWith('wx:')) continue;
      if (/^(bind|catch)(tap|input)$/.test(name)) {
        const method = value;
        element.addEventListener(name.endsWith('tap') ? 'click' : 'input', event => {
          if (name.startsWith('catch')) event.stopPropagation();
          const detail = { value: event.target.value };
          page[method]({ detail, currentTarget: { dataset: { ...element.dataset } } });
        });
      } else if (name === 'disabled') element.disabled = !!value;
      else if (name === 'value') element.value = value == null ? '' : value;
      else if (name === 'password') { if (value) element.type = 'password'; }
      else if (name === 'open-type') { if (value === 'share') element.onclick = () => wx.showToast({ title: '请在微信中使用原生分享' }); }
      else if (name !== 'type' || tag !== 'canvas') element.setAttribute(name, String(value == null ? '' : value));
    }
    if (!['input','canvas'].includes(tag)) element.append(children(node, scope));
    return element;
  }
  function render() {
    if (!page) return;
    const active = document.activeElement, focus = active && screen.contains(active) ? active.getAttribute('bindinput') || active.placeholder : null;
    const position = active && active.selectionStart;
    const scroll = screen.scrollTop;
    const template = sources[pageName + '.wxml'].replace(/wx:else(?=\s|>)/g, 'wx:else=""').replace(/&&/g, '&amp;&amp;');
    const xml = new DOMParser().parseFromString('<root xmlns:wx="urn:wx">' + template + '</root>', 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error(xml.querySelector('parsererror').textContent);
    screen.replaceChildren(children(xml.documentElement, page.data)); screen.scrollTop = scroll;
    if (focus) { const next = [...screen.querySelectorAll('input')].find(input => input.placeholder === focus); if (next) { next.focus(); if (position != null) next.setSelectionRange(position,position); } }
  }
  function tabs() {
    const config = JSON.parse(sources['app.json']); tabbar.innerHTML = '';
    for (const [index, item] of config.tabBar.list.entries()) {
      const button = document.createElement('button'); const active = pageName === item.pagePath;
      button.className = active ? 'active' : ''; button.setAttribute('aria-label', item.text);
      const img = document.createElement('img'); img.src = '/' + (active ? item.selectedIconPath : item.iconPath);
      const label = document.createElement('span'); label.textContent = item.text;
      button.append(img,label); if (index === 1 && badge) { const count = document.createElement('span'); count.className = 'tab-badge'; count.textContent = badge; button.append(count); }
      button.onclick = () => navigate('/' + item.pagePath, false); tabbar.append(button);
    }
  }
  async function navigate(url, push) {
    const parsed = new URL(url, 'http://preview'); const name = parsed.pathname.slice(1);
    if (push && pageName) stack.push({ name: pageName, options: page._options });
    if (!push) stack = [];
    pageName = name; delete modules[name + '.js']; requireModule(name + '.js');
    page = { ...pageDefinition, data: structuredClone(pageDefinition.data), _options: Object.fromEntries(parsed.searchParams), setData(value, callback) { Object.assign(this.data, value); render(); if (callback) queueMicrotask(callback); } };
    const css = (sources['app.wxss'] + '\n' + sources[name + '.wxss']).replace(/(-?[\d.]+)rpx/g, (_, number) => Number(number) * screen.clientWidth / 750 + 'px').replace(/(^|\n)page\s*\{/g, '$1#screen {');
    document.querySelector('#page-styles').textContent = css;
    document.querySelector('#nav-title').textContent = JSON.parse(sources[name + '.json']).navigationBarTitleText;
    document.querySelector('#back').style.display = push ? 'block' : 'none';
    tabbar.style.visibility = name.includes('/device/') ? 'hidden' : 'visible';
    screen.scrollTop = 0; render(); tabs();
    if (page.onLoad) page.onLoad(page._options);
    if (page.onShow) page.onShow();
    if (page.onReady) page.onReady();
    window.__mini = { app, page, requireModule, navigate };
  }
  function modal(options) {
    const dialog = document.querySelector('#modal'), input = document.querySelector('#modal-input'), actions = document.querySelector('#modal-actions');
    document.querySelector('#modal-title').textContent = options.title || '';
    document.querySelector('#modal-content').textContent = options.content || '';
    input.style.display = options.editable ? 'block' : 'none'; input.value = ''; input.placeholder = options.placeholderText || '';
    actions.innerHTML = '';
    const complete = confirm => { dialog.close(); if (options.success) options.success({ confirm, cancel: !confirm, content: input.value }); };
    if (options.showCancel !== false) { const cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.onclick = () => complete(false); actions.append(cancel); }
    const confirm = document.createElement('button'); confirm.className = 'confirm'; confirm.textContent = options.confirmText || '确定'; confirm.onclick = () => complete(true); actions.append(confirm);
    dialog.oncancel = event => { event.preventDefault(); complete(false); }; dialog.showModal();
  }
  const wx = {
    getStorageSync: key => JSON.parse(localStorage.getItem(key) || 'null'), setStorageSync: (key,value) => localStorage.setItem(key,JSON.stringify(value)),
    showToast({title}) { const toast = document.querySelector('#toast'); toast.textContent = title; toast.style.display = 'block'; setTimeout(() => { toast.style.display = 'none'; },2400); },
    showModal: modal,
    showActionSheet(options) { modal({ title: '请选择', showCancel: false }); const actions = document.querySelector('#modal-actions'); actions.style.flexDirection = 'column'; actions.innerHTML = ''; options.itemList.forEach((label,index) => { const button = document.createElement('button'); button.textContent = label; button.onclick = () => { document.querySelector('#modal').close(); actions.style.flexDirection = ''; options.success({tapIndex:index}); }; actions.append(button); }); },
    navigateTo: ({url}) => navigate(url,true), switchTab: ({url}) => navigate(url,false), stopPullDownRefresh() {},
    setTabBarBadge: ({text}) => { badge = text; tabs(); }, removeTabBarBadge: () => { badge = ''; tabs(); },
    scanCode(options) { modal({ title: '模拟扫码', editable: true, placeholderText: '输入设备编号，例如 UPS-A01', success: result => { if (result.confirm) options.success({ result: result.content }); } }); },
    getWindowInfo: () => ({pixelRatio:window.devicePixelRatio}),
    createSelectorQuery() { let selector; const query = { in(){return query}, select(value){selector=value;return query}, fields(){return query}, exec(callback){const node=screen.querySelector(selector);callback(node?[{node,width:node.clientWidth,height:node.clientHeight}]:[])} }; return query; },
    cloud: { init(){}, callFunction(options){queueMicrotask(()=>options.fail({errMsg:'浏览器预览不提供微信身份，请在微信开发者工具使用云模式'}))} },
    request(options) {
      const url = new URL(options.url);
      // Browser preview talks only to its isolated local platform, never an entered remote address.
      if (!['127.0.0.1','localhost'].includes(url.hostname)) return options.fail({errMsg:'请在微信开发者工具连接远程平台'});
      fetch(url.pathname+url.search, { method:options.method||'GET', headers:options.header, ...(options.data?{body:JSON.stringify(options.data)}:{}) }).then(async response=>options.success({statusCode:response.status,data:await response.json()})).catch(error=>options.fail({errMsg:error.message}));
    },
  };
  screen.addEventListener('scroll',()=>{if(screen.scrollTop+screen.clientHeight>=screen.scrollHeight-10 && page.onReachBottom)page.onReachBottom()});
  document.querySelector('#back').onclick=()=>{const previous=stack.pop();if(previous)navigate('/'+previous.name+'?'+new URLSearchParams(previous.options),false)};
  requireModule('app.js'); app.onLaunch(); await navigate('/pages/index/index',false);
})().catch(error=>{document.querySelector('#screen').textContent=error.stack;console.error(error)});
