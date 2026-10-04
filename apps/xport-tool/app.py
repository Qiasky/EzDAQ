"""Small Windows UI for XPort discovery, network setup and live LH8950 readings."""
import argparse
import concurrent.futures
import datetime
import ipaddress
import json
import os
import queue
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk

import xport_core as core

BG, INK, MUTED, TEAL = '#F3F6F8', '#20343D', '#75858E', '#147D72'


class App:
    def __init__(self, root, state_dir=None, load_network=True):
        self.root = root
        self.folder = Path(state_dir or Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'EzDAQ' / 'XPortTool')
        self.folder.mkdir(parents=True, exist_ok=True)
        self.settings_file = self.folder / 'settings.json'
        self.events = queue.Queue()
        self.interfaces = []
        self.devices = {}
        self.reader = None
        self.config_busy = False
        self.closing = False
        self.last_result = None
        self.count_ok = self.count_error = 0
        self.root.title('EzDAQ · XPort 温湿度工具')
        self.root.geometry('900x820')
        self.root.minsize(850, 780)
        self.root.configure(bg=BG)
        self.root.protocol('WM_DELETE_WINDOW', self.close)
        style = ttk.Style(root)
        style.theme_use('clam')
        style.configure('.', font=('Microsoft YaHei UI', 10), background=BG, foreground=INK)
        style.configure('TButton', padding=(12, 7))
        style.configure('Primary.TButton', background=TEAL, foreground='white')
        style.map('Primary.TButton', background=[('active', '#126D64'), ('disabled', '#A6BCB8')])
        style.configure('TNotebook.Tab', padding=(22, 10))
        style.configure('Treeview', rowheight=30, fieldbackground='white', background='white')
        self.adapter = tk.StringVar()
        self.host = tk.StringVar(value='192.168.31.201')
        self.port = tk.StringVar(value='10050')
        self.period = tk.StringVar(value='10')
        self.wait = tk.StringVar(value='10')
        self.status = tk.StringVar(value='未连接')
        self.temp = tk.StringVar(value='—')
        self.humidity = tk.StringVar(value='—')
        self.stats = tk.StringVar(value='尚未读取')
        self.mac = tk.StringVar()
        self.current_ip = tk.StringVar()
        self.new_ip = tk.StringVar(value='192.168.31.201')
        self.mask = tk.StringVar(value='255.255.255.0')
        self.gateway = tk.StringVar(value='192.168.31.1')
        self.setup_status = tk.StringVar(value='选择电脑网卡，查找并选中模块；端口只读取，保持原值。')
        self._load_settings()
        self._build()
        self.root.after(80, self._drain)
        if load_network:
            self.refresh_interfaces()

    def _load_settings(self):
        try:
            settings = json.loads(self.settings_file.read_text(encoding='utf-8'))
            for key in ('host', 'port', 'period', 'wait'):
                if key in settings:
                    getattr(self, key).set(str(settings[key]))
        except (OSError, ValueError):
            pass

    def _save_settings(self):
        self.settings_file.write_text(json.dumps({key: getattr(self, key).get() for key in ('host', 'port', 'period', 'wait')}, indent=2), encoding='utf-8')

    def _build(self):
        header = ttk.Frame(self.root, padding=(22, 16))
        header.pack(fill='x')
        ttk.Label(header, text='XPort 温湿度工具', font=('Microsoft YaHei UI', 20, 'bold')).pack(anchor='w')
        ttk.Label(header, text='查找模块 · 修改 IP · 实时读取 LH8950', foreground=MUTED).pack(anchor='w', pady=(3, 12))
        row = ttk.Frame(header)
        row.pack(fill='x')
        ttk.Label(row, text='电脑网卡').pack(side='left', padx=(0, 10))
        self.adapter_box = ttk.Combobox(row, textvariable=self.adapter, state='readonly', width=48)
        self.adapter_box.pack(side='left', fill='x', expand=True)
        self.refresh_button = ttk.Button(row, text='刷新网卡', command=self.refresh_interfaces)
        self.refresh_button.pack(side='left', padx=(8, 0))
        ttk.Button(row, text='网段帮助', command=self.network_help).pack(side='left', padx=(8, 0))
        self.tabs = ttk.Notebook(self.root)
        self.tabs.pack(fill='both', expand=True, padx=22, pady=(0, 16))
        live = ttk.Frame(self.tabs, padding=18)
        setup = ttk.Frame(self.tabs, padding=18)
        self.tabs.add(live, text='实时采集')
        self.tabs.add(setup, text='查找 / 改 IP')
        self._live_page(live)
        self._setup_page(setup)

    @staticmethod
    def field(parent, label, variable, width=16):
        ttk.Label(parent, text=label).pack(side='left', padx=(0, 6))
        entry = ttk.Entry(parent, textvariable=variable, width=width)
        entry.pack(side='left', padx=(0, 14))
        return entry

    def _live_page(self, page):
        row = ttk.Frame(page)
        row.pack(fill='x')
        self.live_fields = [self.field(row, '设备 IP', self.host, 18), self.field(row, '端口', self.port, 7)]
        self.start_button = ttk.Button(row, text='开始采集', style='Primary.TButton', command=self.start)
        self.start_button.pack(side='left', padx=4)
        self.stop_button = ttk.Button(row, text='停止', command=self.stop, state='disabled')
        self.stop_button.pack(side='left', padx=4)
        timing = ttk.Frame(page)
        timing.pack(fill='x', pady=(12, 16))
        self.live_fields += [self.field(timing, '采集周期（秒）', self.period, 6), self.field(timing, '发送后等待（秒）', self.wait, 6)]
        ttk.Label(timing, text='接收超时 10 秒', foreground=MUTED).pack(side='left')
        self.status_label = ttk.Label(page, textvariable=self.status, font=('Microsoft YaHei UI', 12, 'bold'), foreground=MUTED, wraplength=770)
        self.status_label.pack(anchor='w', pady=(0, 12))
        cards = tk.Frame(page, bg=BG)
        cards.pack(fill='x')
        for col, (label, var) in enumerate((('温度  ℃', self.temp), ('湿度  %RH', self.humidity))):
            card = tk.Frame(cards, bg='white', padx=18, pady=12, highlightthickness=1, highlightbackground='#E0E8EB')
            card.grid(row=0, column=col, sticky='nsew', padx=(0, 8) if col == 0 else (8, 0))
            cards.columnconfigure(col, weight=1)
            tk.Label(card, text=label, bg='white', fg=MUTED, font=('Microsoft YaHei UI', 11)).pack(anchor='w')
            tk.Label(card, textvariable=var, bg='white', fg=INK, font=('Microsoft YaHei UI', 32, 'bold')).pack(anchor='w', pady=(2, 0))
        ttk.Label(page, textvariable=self.stats, foreground=MUTED).pack(anchor='w', pady=(10, 12))
        self.tx = self._hex_box(page, '发送 HEX', 2)
        self.rx = self._hex_box(page, '接收 HEX · 最近接收的原始字节', 3)
        ttk.Label(page, text='通讯记录', font=('Microsoft YaHei UI', 10, 'bold')).pack(anchor='w', pady=(8, 4))
        log_frame = ttk.Frame(page)
        log_frame.pack(fill='both', expand=True)
        self.log = tk.Text(log_frame, height=5, font=('Microsoft YaHei UI', 9), wrap='word', bg='white', fg=MUTED, relief='flat', state='disabled')
        scroll = ttk.Scrollbar(log_frame, orient='vertical', command=self.log.yview)
        self.log.configure(yscrollcommand=scroll.set)
        scroll.pack(side='right', fill='y')
        self.log.pack(side='left', fill='both', expand=True)

    def _hex_box(self, page, title, height):
        ttk.Label(page, text=title, font=('Microsoft YaHei UI', 10, 'bold')).pack(anchor='w', pady=(0, 4))
        box = tk.Text(page, height=height, font=('Consolas', 10), wrap='word', bg='white', fg=INK,
                      relief='flat', padx=10, pady=7, state='disabled')
        box.pack(fill='x', pady=(0, 9))
        return box

    def _setup_page(self, page):
        row = ttk.Frame(page)
        row.pack(fill='x')
        self.find_button = ttk.Button(row, text='查找 XPort', style='Primary.TButton', command=self.find)
        self.find_button.pack(side='left')
        self.read_button = ttk.Button(row, text='读取选中设备', command=self.read_config)
        self.read_button.pack(side='left', padx=8)
        self.use_button = ttk.Button(row, text='用于实时采集', command=self.use_device)
        self.use_button.pack(side='left')
        ttk.Label(page, text='MAC 与模块标签对应；双击列表可读取 IP / 端口。', foreground=MUTED).pack(anchor='w', pady=(12, 8))
        self.table = ttk.Treeview(page, columns=('mac', 'ip', 'port', 'evidence'), show='headings', height=6, selectmode='browse')
        for key, title, width in (('mac', 'MAC 地址', 190), ('ip', '当前 IP', 155), ('port', 'TCP 端口', 90), ('evidence', '状态', 225)):
            self.table.heading(key, text=title)
            self.table.column(key, width=width, minwidth=70)
        self.table.pack(fill='x')
        self.table.bind('<<TreeviewSelect>>', self.select_device)
        self.table.bind('<Double-1>', lambda event: self.read_config())
        frame = ttk.LabelFrame(page, text='网络参数（TCP 端口保持原值）', padding=16)
        frame.pack(fill='x', pady=16)
        for row_num, (label, variable, readonly) in enumerate((('模块 MAC', self.mac, False), ('当前 IP', self.current_ip, False), ('新 IP', self.new_ip, False), ('子网掩码', self.mask, False), ('网关', self.gateway, False))):
            ttk.Label(frame, text=label).grid(row=row_num, column=0, sticky='w', pady=4, padx=(0, 12))
            ttk.Entry(frame, textvariable=variable, width=28, state='readonly' if readonly else 'normal').grid(row=row_num, column=1, sticky='w', pady=4)
        self.change_button = ttk.Button(frame, text='保存新 IP', style='Primary.TButton', command=self.change)
        self.change_button.grid(row=2, column=2, padx=28)
        ttk.Label(frame, text='写入前重新核对 MAC 并备份配置。\n模块保存后会短暂重启。', foreground=MUTED).grid(row=3, column=2, rowspan=2, sticky='w', padx=28)
        ttk.Label(page, textvariable=self.setup_status, foreground=TEAL, wraplength=770).pack(anchor='w', pady=4)

    def selected_interface(self):
        index = self.adapter_box.current()
        if not 0 <= index < len(self.interfaces):
            raise core.DeviceError('请先选择电脑网卡')
        return dict(self.interfaces[index])

    def refresh_interfaces(self):
        if self.reader or self.config_busy:
            return
        self.refresh_button.configure(state='disabled')
        self._background('interfaces', core.list_interfaces)

    def _background(self, event, function):
        def worker():
            try:
                self.events.put((event, function()))
            except Exception as exc:
                self.events.put((event + '_error', str(exc)))
        threading.Thread(target=worker, daemon=True).start()

    def set_config_busy(self, value):
        self.config_busy = value
        for button in (self.find_button, self.read_button, self.use_button, self.change_button, self.refresh_button):
            button.configure(state='disabled' if value or self.reader else 'normal')
        self.start_button.configure(state='disabled' if value or self.reader else 'normal')
        self.adapter_box.configure(state='disabled' if value or self.reader else 'readonly')

    def find(self):
        try:
            interface = self.selected_interface()
        except ValueError as exc:
            messagebox.showerror('查找模块', str(exc), parent=self.root)
            return
        self.set_config_busy(True)
        self.setup_status.set('正在查找，约 6 秒…')
        def operation():
            records = {}
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                udp = pool.submit(core.discover_udp, interface)
                arp = pool.submit(core.discover_arp, interface)
                for row in arp.result():
                    records[(row['mac'], row['ip'])] = row
                for row in udp.result():
                    records[(row['mac'], row['ip'])] = row
            for row in records.values():
                if ipaddress.IPv4Address(row['ip']) in core.network_for(interface):
                    try:
                        info, _ = core.read_setup(interface, row['ip'], row['mac'])
                        row.update(info, evidence='MAC 与配置已核对')
                    except (OSError, ValueError):
                        row['evidence'] = '已发现；配置读取失败'
            return list(records.values())
        self._background('found', operation)

    def select_device(self, event=None):
        selection = self.table.selection()
        if selection:
            row = self.devices[selection[0]]
            self.mac.set(row['mac'])
            self.current_ip.set(row['ip'])
            if row.get('mask'):
                self.mask.set(row['mask'])
                self.gateway.set(row['gateway'])

    def _target(self):
        interface = self.selected_interface()
        mac = core.normalize_mac(self.mac.get())
        target = core.require_local(interface, self.current_ip.get().strip())
        return interface, target, mac

    def read_config(self):
        try:
            interface, target, mac = self._target()
        except ValueError as exc:
            messagebox.showerror('读取配置', str(exc), parent=self.root)
            return
        self.set_config_busy(True)
        self.setup_status.set('正在核对 MAC 并读取配置…')
        self._background('setup', lambda: core.read_setup(interface, target, mac)[0])

    def use_device(self):
        row = next((value for value in self.devices.values() if value['mac'] == self.mac.get() and value['ip'] == self.current_ip.get() and value.get('port')), None)
        if not row:
            messagebox.showinfo('实时采集', '先点“读取选中设备”，取得实际 TCP 端口。', parent=self.root)
            return
        self.host.set(row['ip'])
        self.port.set(str(row['port']))
        self.tabs.select(0)

    def change(self):
        try:
            interface, target, mac = self._target()
            new_ip = str(ipaddress.IPv4Address(self.new_ip.get().strip()))
            mask = self.mask.get().strip()
            gateway = self.gateway.get().strip()
            # Validate before any network write; the worker will use the fresh original record.
            dummy = bytearray(120)
            dummy[:4] = ipaddress.IPv4Address(target).packed
            dummy[6] = 8
            dummy[20:22] = (10050).to_bytes(2, 'little')
            core.prepare_change(bytes(dummy), new_ip, mask, gateway)
            if new_ip == interface['ip']:
                raise core.DeviceError('新地址与电脑网卡 IP 冲突')
        except ValueError as exc:
            messagebox.showerror('修改 IP', str(exc), parent=self.root)
            return
        if not messagebox.askyesno('保存网络参数', f'MAC：{mac}\n当前 IP：{target}\n新 IP：{new_ip}\n子网掩码：{mask}\n网关：{gateway}\n\nTCP 端口保持原值。确认保存并重启此模块？', parent=self.root):
            return
        self.set_config_busy(True)
        self.setup_status.set('正在核对 MAC、备份并写入…')
        self._background('changed', lambda: core.change_ip(interface, target, mac, new_ip, mask, gateway, self.folder / 'backups'))

    def network_help(self):
        try:
            interface = self.selected_interface()
            target = ipaddress.IPv4Address(self.current_ip.get().strip() or self.host.get().strip())
        except ValueError as exc:
            messagebox.showinfo('网段帮助', str(exc), parent=self.root)
            return
        if interface['alias'].lower() in ('wlan', 'wi-fi', 'wifi') or '无线' in interface['alias']:
            messagebox.showinfo('网段帮助', '临时改网段时先将模块直连电脑有线网口，并在上方选择“以太网”网卡。', parent=self.root)
            return
        network = ipaddress.IPv4Network(f'{target}/24', strict=False)
        candidate = network.network_address + (200 if int(target) & 255 != 200 else 199)
        alias = interface['alias'].replace('"', '')
        command = f'netsh interface ipv4 set address name="{alias}" source=static address={candidate} mask=255.255.255.0 gateway=none'
        text = (f"当前电脑网卡：{alias}，{interface['ip']}/{interface['prefix']}\n模块：{target}\n\n"
                '若二者不在同一网段：模块直连电脑有线网卡，确认下列电脑地址未被占用，再在管理员 PowerShell 执行。\n'
                f'{command}\n\n改完模块 IP 后可将模块接回路由器，改用电脑 Wi-Fi 网卡读取。\n'
                f'如原电脑网卡使用自动获取，恢复命令：\nnetsh interface ipv4 set address name="{alias}" source=dhcp')
        popup = tk.Toplevel(self.root)
        popup.title('网段帮助')
        popup.geometry('720x360')
        box = tk.Text(popup, wrap='word', font=('Microsoft YaHei UI', 10), padx=16, pady=16)
        box.pack(fill='both', expand=True)
        box.insert('1.0', text)
        box.configure(state='disabled')
        def copy():
            self.root.clipboard_clear()
            self.root.clipboard_append(command)
        ttk.Button(popup, text='复制临时设置命令', command=copy).pack(pady=10)

    def start(self):
        try:
            interface = self.selected_interface()
            host = core.require_local(interface, self.host.get().strip())
            port = int(self.port.get())
            period, wait = float(self.period.get()), float(self.wait.get())
            if not 1 <= port <= 65535 or not 1 <= period <= 3600 or not 0 <= wait <= 60:
                raise ValueError('端口须为 1～65535，周期须为 1～3600 秒，等待须为 0～60 秒')
        except ValueError as exc:
            messagebox.showerror('开始采集', str(exc), parent=self.root)
            return
        self._save_settings()
        self.reader = core.SensorReader()
        self.set_config_busy(False)
        self.stop_button.configure(state='normal')
        for field in self.live_fields:
            field.configure(state='disabled')
        self.count_ok = self.count_error = 0
        self.last_result = None
        self.temp.set('—')
        self.humidity.set('—')
        self.write_box(self.tx, '')
        self.write_box(self.rx, '')
        reader = self.reader
        def run():
            while not reader.stop_event.is_set():
                started = time.monotonic()
                try:
                    metrics, raw = reader.read(host, port, interface['ip'], wait,
                                               notify=lambda kind, value: self.events.put((kind, value)))
                    self.events.put(('sample', dict(metrics, raw=raw)))
                except (OSError, ValueError) as exc:
                    if not reader.stop_event.is_set():
                        self.events.put(('sample_error', dict(message=str(exc), raw=getattr(exc, 'raw', b''))))
                if reader.stop_event.wait(max(0, period - (time.monotonic() - started))):
                    break
            self.events.put(('stopped', None))
        threading.Thread(target=run, daemon=True).start()

    def stop(self):
        if self.reader:
            self.reader.stop()
            self.status.set('正在停止…')
            self.stop_button.configure(state='disabled')

    @staticmethod
    def write_box(widget, text):
        widget.configure(state='normal')
        widget.delete('1.0', 'end')
        widget.insert('1.0', text)
        widget.configure(state='disabled')

    def add_log(self, text):
        self.log.configure(state='normal')
        self.log.insert('end', time.strftime('%H:%M:%S') + '  ' + text + '\n')
        lines = int(self.log.index('end-1c').split('.')[0])
        if lines > 200:
            self.log.delete('1.0', f'{lines - 200}.0')
        self.log.see('end')
        self.log.configure(state='disabled')

    def _put_device(self, row):
        iid = row['mac'] + '_' + row['ip']
        self.devices[iid] = row
        values = (row['mac'], row['ip'], row.get('port', ''), row.get('evidence', '配置已读取'))
        if self.table.exists(iid):
            self.table.item(iid, values=values)
        else:
            self.table.insert('', 'end', iid=iid, values=values)
        return iid

    def _handle(self, kind, value):
        if kind == 'interfaces':
            self.interfaces = value
            self.adapter_box.configure(values=[f"{row['alias']} · {row['ip']}/{row['prefix']}" for row in value])
            if value:
                target = ipaddress.IPv4Address(self.host.get())
                preferred = next((i for i, row in enumerate(value) if target in core.network_for(row)), 0)
                self.adapter_box.current(preferred)
            self.refresh_button.configure(state='normal')
        elif kind == 'interfaces_error':
            self.refresh_button.configure(state='normal')
            self.status.set(value)
        elif kind == 'found':
            self.table.delete(*self.table.get_children())
            self.devices.clear()
            for row in value:
                self._put_device(row)
            self.set_config_busy(False)
            self.setup_status.set(f'发现 {len(value)} 台模块。选中后读取配置；跨网段请先看“网段帮助”。' if value else '未发现模块。检查网线 / 所选网卡，未知跨网段设备可断电再上电后重试查找。')
        elif kind == 'setup':
            self.set_config_busy(False)
            self.mac.set(value['mac'])
            self.current_ip.set(value['ip'])
            self.mask.set(value['mask'])
            self.gateway.set(value['gateway'])
            iid = self._put_device(value)
            self.table.selection_set(iid)
            self.setup_status.set(f"已核对 MAC；IP {value['ip']}，TCP 端口 {value['port']}，掩码 {value['mask']}，网关 {value['gateway']}。")
        elif kind == 'changed':
            self.set_config_busy(False)
            self.last_result = value
            self.current_ip.set(value['newIp'])
            self.host.set(value['newIp'])
            self.port.set(str(value['port']))
            # Old table rows are invalid after a reboot; require a fresh read to show a verified configuration.
            self.table.delete(*self.table.get_children())
            self.devices.clear()
            ack = '模块已确认写入' if value['acknowledged'] else '未收到确认，结果待核对，请先查找设备，勿重复写入'
            self.setup_status.set(f"{ack}。目标 {value['newIp']}:{value['port']}；连接新网段后查找 / 读取核对。备份：{value['backup']}")
        elif kind.endswith('_error') and kind != 'sample_error':
            self.set_config_busy(False)
            self.setup_status.set(value)
            messagebox.showerror('操作未完成', value, parent=self.root)
        elif kind == 'status':
            last_ok = bool(self.last_result and 'temperature' in self.last_result)
            prefix = '上次通讯正常 · ' if last_ok else '上次通讯失败 · ' if self.last_result else ''
            self.status.set(prefix + value)
            self.status_label.configure(foreground=TEAL if last_ok else MUTED)
        elif kind in ('tx', 'rx'):
            self.write_box(self.tx if kind == 'tx' else self.rx, value.hex(' ').upper())
        elif kind == 'sample':
            self.count_ok += 1
            self.last_result = value
            self.temp.set(f"{value['temperature']:.2f}")
            self.humidity.set('无效' if value['humidity'] is None else f"{value['humidity']:.1f}")
            self.status.set('通讯正常 · 湿度原始值 FFFF（检查探头）' if value['humidity'] is None else '通讯正常')
            self.status_label.configure(foreground=TEAL)
            self.stats.set(f"更新 {time.strftime('%H:%M:%S')} · 成功 {self.count_ok} / 失败 {self.count_error} · 响应地址 0x{value['address']:02X}")
            self.add_log(f"温度 {self.temp.get()}℃；湿度 {self.humidity.get()}{' %RH' if value['humidity'] is not None else ''}")
        elif kind == 'sample_error':
            self.count_error += 1
            self.last_result = value
            self.temp.set('—')
            self.humidity.set('—')
            self.status.set(value['message'])
            self.status_label.configure(foreground='#C25844')
            self.write_box(self.rx, value['raw'].hex(' ').upper() or '未收到数据')
            self.stats.set(f"失败 {time.strftime('%H:%M:%S')} · 成功 {self.count_ok} / 失败 {self.count_error}")
            self.add_log(value['message'])
        elif kind == 'stopped':
            self.reader = None
            self.set_config_busy(False)
            self.stop_button.configure(state='disabled')
            for field in self.live_fields:
                field.configure(state='normal')
            self.status.set('已停止 · 显示最后一次读取结果')
            self.status_label.configure(foreground=MUTED)

    def _drain(self):
        if self.closing:
            return
        while True:
            try:
                kind, value = self.events.get_nowait()
            except queue.Empty:
                break
            self._handle(kind, value)
        self.root.after(80, self._drain)

    def close(self):
        if self.config_busy:
            messagebox.showinfo('操作进行中', '请等当前查找 / 配置操作完成后再关闭。', parent=self.root)
            return
        self.closing = True
        if self.reader:
            self.reader.stop()
        self.root.destroy()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', type=Path, help='内部启动检查结果文件')
    args = parser.parse_args()
    root = tk.Tk()
    app = App(root, state_dir=args.self_test.parent if args.self_test else None, load_network=not args.self_test)
    if args.self_test:
        def check():
            root.update_idletasks()
            report = dict(title=root.title(), tabs=[app.tabs.tab(i, 'text') for i in range(2)],
                          width=root.winfo_width(), height=root.winfo_height(), tx_visible=bool(app.tx.winfo_viewable()),
                          rx_visible=bool(app.rx.winfo_viewable()), log_height=app.log.winfo_height(),
                          log_bottom=app.log.winfo_rooty() + app.log.winfo_height() - root.winfo_rooty(), initialized=True)
            args.self_test.write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
            app.close()
        root.after(600, check)
    root.mainloop()


if __name__ == '__main__':
    main()
