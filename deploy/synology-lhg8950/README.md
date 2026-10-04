# 群晖 NAS 部署韩感 LH8950 采集程序

适用本次设备：DS920+、DSM 7.2.2，使用官方 Container Manager 套件。

部署后链路为：**LH8950 / XPort → NAS 容器采集 → 微信云开发 → 手机小程序**。电脑可以关机，NAS 必须持续开机并能连接传感器和互联网。无需路由器端口映射，也无需给 NAS 采集容器开放任何端口。

## 1. 当前设备参数

| 参数 | 本次迁移值 |
| --- | --- |
| 传感器 IP / TCP 端口 | `192.168.31.178:10050` |
| MAC | `00:20:4A:A6:FB:43` |
| 云设备编号 | `HOME-TH-001` |
| 响应地址 | `27`，即 `0x1B` |
| 发命令后等待 | `10000` 毫秒 |
| 采集周期 | `35000` 毫秒 |
| 湿度无效值 | `65535`，即 `FFFF`，保留有效温度 |

NAS 的 IP 与传感器 IP 是两个不同地址。NAS 连接到同一家庭局域网即可，不应把它改成传感器的 `.178`。

这是迁移已运行的设备 A，沿用当前密钥和台账，不运行 `--init`、不新建 `devices` 记录。另一台 `.201` 模块的响应地址为 `1`，不能直接替换上述 IP 用于上报。

## 2. 生成上传包

在开发电脑的仓库根目录运行：

```powershell
python -B deploy/synology-lhg8950/package.py --with-current-config
```

生成 `release/synology-lhg8950.private.zip`，携带当前设备配置及密钥，可直接迁移。该目录已被 Git 忽略；此包只上传到自己的 NAS，不放到公共仓库。

省略 `--with-current-config` 时生成 `release/synology-lhg8950.zip`。它仅有公开参数，`secret` 为空，必须补入与现有云端台账一致的设备密钥才能上报。

压缩包内容：

```text
docker-compose.yml
README.md
app/
  lhg8950_gateway.py
  lhg8950.config.example.json
config/
  lhg8950.config.local.json
```

打包脚本从仓库中复制当前驱动，不维护第二份采集源码。NAS 不需要安装 Python 套件或任何 pip 依赖。

## 3. 在 DSM 上传并解压

1. 登录 DSM，打开 **套件中心**，搜索并安装官方 **Container Manager**。已安装则直接打开。
2. 打开 **File Station**，在 `docker` 共享文件夹下新建 `ezdaq-lhg8950` 目录。如果没有 `docker` 共享文件夹，可以使用已有可访问的共享文件夹。
3. 上传 `synology-lhg8950.private.zip`，解压到这个目录。
4. 检查 `docker-compose.yml`、`app` 和 `config` 在同一层。例如 `/volume1/docker/ezdaq-lhg8950/docker-compose.yml`。不要多套一层同名文件夹。

`/volume1` 仅为例子，以你 NAS 的实际路径为准。Container Manager 和 File Station 运行账号须有读取该目录的权限。

## 4. 建立容器项目并切换采集

1. 在 Container Manager 的 **映像 / 注册表** 中准备官方镜像 `python:3.13-slim-bookworm`。也可由建立项目时自动下载。
2. 打开 **项目 → 新增 / 创建**。
3. 项目名称填写 `ezdaq-lhg8950`，路径选择刚才解压的目录。
4. 来源选择使用该目录现有的 `docker-compose.yml`；若界面要求上传文件，上传包内的这个文件。不要只粘贴 YAML 却漏掉 `app` 和 `config` 目录。
5. 不启用 Web Station 门户。此程序没有网页服务，不配置端口映射。
6. 首次建立时取消立即启动项目。先等待镜像下载完成，再停止电脑上的该设备采集程序或 LabVIEW / 桌面实时采集，然后启动 NAS 项目。
7. 打开容器 `ezdaq-lhg8950` 的 **日志**，观察至少两轮采集结果。

电脑上的后台进程信息记录在 `apps/wechat-miniprogram/.local/lantronix/gateway-process.local.json`。停止时核对实际进程命令行，再停止对应 `lhg8950_gateway.py --watch` 进程，不能使用旧进程编号、不能关闭所有 Python 程序。

预期日志（温度是示例）：

```text
采集 192.168.31.178:10050；等待 10000ms；周期 35000ms
接收 HEX：3a 31 42 30 34 ... 0d 0a
温度 24.0625℃；湿度 无效，请检查探头（保留有效温度）
云端保存成功，状态=normal
```

只有出现 **云端保存成功** 才说明本轮已更新云数据；容器状态“运行中”只能说明进程在运行。

在手机小程序下拉刷新，打开 `HOME-TH-001`，确认上报时间持续更新、温度有真实读数。当前探头湿度无效属于已确认的传感器状态。

确认 NAS 连续上报后，关闭电脑测试一个完整采集周期，确认手机里的上报时间仍更新。此步骤完成后才能认定已脱离电脑运行。

## 5. 持续运行与维护

- `restart: unless-stopped`：容器退出或 NAS 重启后，Docker 服务启动时恢复运行；手动停止的容器需手动启动。
- 默认每 35 秒采集一次。单次 TCP 超时可能延长间隔；采集 / 上报失败会写日志并继续下一轮。
- 程序和配置只读挂载；修改 NAS 上的配置后重启项目，因为驱动在启动时读取参数。
- Docker 日志每个文件最多约 5 MB、保留 2 个文件，防止持续日志占满磁盘。
- NAS 系统时间应自动同步；云端签名会检查时间戳。当前微信云端约 90 秒没有更新即按离线处理。
- 网络使用容器默认桥接，只需要访问局域网 TCP 10050 和云端 HTTPS 443。无需特权、host 网络或管理端口开放。

可选 SSH 检查命令（已安装 Docker 且有权限时）：

```sh
cd /volume1/docker/ezdaq-lhg8950
sudo docker compose up -d
sudo docker logs --tail 30 ezdaq-lhg8950
sudo docker compose stop
```

旧版套件只有 `docker-compose` 命令时，以它替换 `docker compose`，或直接使用 DSM 的项目界面。

## 6. 排查常见问题

| 现象 | 处理 |
| --- | --- |
| 套件中心看不到 Container Manager | 核对 DSM 与型号；DS920+ 在官方支持列表，先检查官方套件来源与套件中心状态 |
| 镜像下载失败 | 核对 NAS 能否访问 Docker Hub、DNS 和出站网络；可以从另一台电脑下载官方 Linux amd64 镜像后导出、在 Container Manager 中导入 |
| 报“缺少设备密钥” | 上传的是公开包，改用私有迁移包，或填写现有设备密钥 |
| 尚未设置传感器 IP / 响应地址不一致 | 核对 `config/lhg8950.config.local.json` 是否来自当前 `.178` 设备 |
| TCP 超时 / 连接拒绝 | 检查 `.178:10050`、网线和电源，并确保电脑 / LabVIEW 已停止读取同一模块 |
| 配置文件权限错误 | 用 File Station 检查项目目录权限，确保容器可读取 `app` 和 `config` |
| 云端拒绝签名 / 时间戳 | 设备编号与密钥须和现有台账一致；检查 NAS 自动校时与出站 HTTPS |
| 手机设备离线 | 先看最新容器日志和上报时间，确认是否真的收到云端保存回执 |

目前提供的是部署文件和可上传的迁移包；NAS 容器启动、真实上报与电脑关机后的独立运行，需要在实际 NAS 上完成验证。部署前不自动停止现有电脑采集进程。

参考：[群晖 Container Manager 套件与支持型号](https://www.synology.com/en-global/dsm/packages/ContainerManager)、[群晖项目操作说明](https://kb.synology.com/en-global/DSM/help/ContainerManager/docker_project)、[Python 官方镜像清单](https://github.com/docker-library/official-images/blob/master/library/python)。
