# EzDAQ EPS MVP 0.1.0 Release

这是首个可运行、可迁移的 MVP 平台基线，包含中心 HTTP 服务、浏览器控制台、模拟设备采集、告警确认/关闭和本地持久化。

## 快速启动

需要 Node.js 20 或更高版本：

```powershell
cd apps/center-platform
npm start
```

打开 `http://localhost:8080`。

## Docker 部署

```powershell
docker compose up -d --build
```

数据保存在 Docker 卷 `ezdaq-data` 中。升级前请备份该卷；停止服务使用 `docker compose down`，不会删除数据卷。

## 验证

```powershell
cd apps/center-platform
npm test
```

## 迁移边界

本版本为零外部依赖的可运行基线，便于小型客户演示和部署验证。后续按技术方案替换为 Vue 3、Java 21 Spring Boot、PostgreSQL/TimescaleDB、MQTT 和 Go 采集网关时，应保持 `/api/*` 资源模型与告警状态机契约稳定。
