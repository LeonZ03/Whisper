# Cloudflare 新项目部署交接说明

更新日期：2026-10-08

## 目标

使用 Cloudflare 免费能力，为新项目绑定：

```text
<新子域名>.leonz03.dpdns.org
```

根域名是 `leonz03.dpdns.org`。现有 Whisper 使用 `whisper.leonz03.dpdns.org`。新项目必须使用独立的 Worker、D1、Durable Object 或 Tunnel 配置，不要修改 Whisper 的 Worker、D1、Durable Objects、迁移和现有部署。

## 先判断项目使用哪种架构

### 方案 A：项目适合 Cloudflare Workers

适合 JavaScript / TypeScript API、静态网页、D1 数据库和 Workers Durable Objects，不需要常驻 Node.js 进程的项目。

Cloudflare Custom Domain 可以直接把子域名绑定到 Worker。Custom Domain 需要活跃的 Cloudflare Zone 和一个 Worker，Cloudflare 会自动创建相关 DNS 记录。一个 Worker 可以配置多个 Custom Domain，但目标主机不能已有冲突的 CNAME。

参考：[Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

示意配置：

```json
{
  "name": "new-project",
  "main": "dist/worker.mjs",
  "account_id": "<从 Cloudflare 控制台确认>",
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    {
      "pattern": "<新子域名>.leonz03.dpdns.org",
      "custom_domain": true
    }
  ]
}
```

新项目的 D1、Durable Object 和迁移必须使用独立名称，不能复用 Whisper 的生产资源。

### 方案 B：项目需要常驻服务器或本机服务

使用 Cloudflare Tunnel：

```text
<新子域名>.leonz03.dpdns.org CNAME <tunnel-id>.cfargotunnel.com
```

Tunnel 负责把公网请求转发到服务器上的本地服务。

不要把 API Token、Tunnel Token 或其他 Cloudflare 凭据放进 exe、APK、CLI 安装包、前端 JavaScript、Git 仓库、README 或公开下载包。Tunnel token 只能放在实际运行服务的服务器环境或 Secret 管理器中。

## Whisper 实际采用的流程

Whisper 当时不是通过浏览器手动点击 Cloudflare 部署，而是：

1. 在本地仓库完成代码、测试和构建；
2. 检查 `wrangler.jsonc`；
3. 提交并推送 `main`；
4. Cloudflare Workers Builds 根据 GitHub 的 `main` 分支自动部署；
5. 没有在 CI 中自动执行生产数据库迁移；
6. 部署后访问正式域名的 `/api/health`；
7. 核对 HTTP 状态、版本号和部署 commit 是否一致；
8. 再检查网页资源、API、WebSocket、下载包和安全响应头。

Whisper 的代码发布命令是：

```text
wrangler deploy
```

代码部署和数据库迁移分开：

```text
npm run deploy:cloud:code
npm run db:migrate:cloud
```

新项目不能默认自动执行远程数据库迁移。迁移应先在隔离数据库验证，再由所有者单独确认。

## 浏览器操作方式

### 之前实际使用的浏览器操作

我使用的是 Codex 的内置浏览器和 `cua_repl`，不是直接控制用户的系统浏览器。基本流程是：

1. 获取当前浏览器状态；
2. 选择 Codex In-app Browser；
3. 打开目标 URL；
4. 读取页面可访问性树，确认当前页面和按钮；
5. 使用页面中的可访问名称点击或填写；
6. 每次操作后重新读取页面状态；
7. 最后保存页面截图作为结果证明。

示意调用流程：

```javascript
await cua.getState();

const browser = await cua.getBrowser({ id: "iab" });

const tab = await cua.createBrowserTab(
  "iab",
  "https://dash.cloudflare.com/",
  { visible: true }
);

await tab.getAXState();
```

操作后必须重新读取：

```javascript
await tab.getAXState();
```

需要页面证据时：

```javascript
const screenshot = await tab.getScreenshot();
```

### Cloudflare 控制台建议顺序

1. 打开 Cloudflare Dashboard；
2. 确认登录的是正确账户；
3. 打开 Websites，确认 `leonz03.dpdns.org` 显示为 Active；
4. 确认没有误选 Whisper 的 Worker、D1 或 Durable Object；
5. 如果采用 Worker Custom Domain：进入 `Workers & Pages → 新项目 Worker → Settings → Domains & Routes`，添加新子域名并检查同名 DNS 或路由冲突；
6. 如果采用 Tunnel：进入 `Zero Trust → Networks → Tunnels`，创建独立 Tunnel，配置 Public Hostname，并在 DNS 中创建 CNAME；
7. 打开对应资源的 Metrics / Usage 页面；
8. 确认没有自动升级到付费计划；
9. 最后访问新域名验证。

浏览器操作只用于控制台设置、查看状态和发布证明。敏感凭据不要通过浏览器表单复制给 Agent，也不要截图包含 token 的页面。

## 最小权限

### 只读前置检查

建议只给：

- Zone Read：只限 `leonz03.dpdns.org`；
- Workers Routes Read；
- 对应 Worker 的只读权限；
- 检查 Tunnel 时使用 Cloudflare Tunnel Read；
- 检查用量时使用对应产品的 Metrics / Usage Read。

### 创建和配置 Tunnel

最小需要：

- Account：`Cloudflare Tunnel Write` 或控制台对应的 Tunnel Edit；
- Zone `leonz03.dpdns.org`：`DNS Write`；
- 读取 Tunnel 状态时使用 Tunnel Read 即可。

如果只是让已经存在的 Tunnel 运行，不需要把账户级 API Token 放到服务器程序中，只给服务器指定 Tunnel 的运行凭据。

参考：[创建 Tunnel API](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)、[Tunnel 权限](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/)

### 添加 Worker Custom Domain

根据 Cloudflare 当前权限说明，需要：

- 目标 Worker 的 Editor 权限；
- 目标 Zone 的 Workers Routes Write。

不要给新项目访问 Whisper 的 D1、Durable Object 或 Worker 权限。

参考：[Workers 权限](https://developers.cloudflare.com/workers/authorization/workers/)

## 部署验证清单

新项目部署后至少验证：

```text
GET https://<新子域名>.leonz03.dpdns.org/
GET https://<新子域名>.leonz03.dpdns.org/api/health
```

核对：

- HTTPS 正常；
- 返回版本号正确；
- `/api/health` 中的 commit 与刚推送的 commit 一致；
- WebSocket 或 API 正常；
- DNS 没有误指向 Whisper；
- 新项目没有读取 Whisper 的 D1 或 Durable Object；
- 没有执行未经批准的生产迁移；
- 没有启用付费计划或付费产品；
- Git 工作区干净；
- Cloudflare 控制台中的 Worker、Tunnel、DNS 和用量均对应新项目。

## 免费计划边界

实际剩余量必须在控制台查看，重点页面是：

- `Workers & Pages → Worker → Metrics / Usage`
- `D1 → Database → Metrics / Usage`
- `Durable Objects → Namespace → Metrics`
- `Workers KV → Namespace → Usage`
- `Billing → Billable Usage`

官方限制页面：

- [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workers KV Pricing](https://developers.cloudflare.com/kv/platform/pricing/)

不要把公开额度当作当前账户剩余额度，也不要把本地测试吞吐量当作正式并发容量。

## 重要安全要求

- 不要修改 `whisper.leonz03.dpdns.org`；
- 不要复用 Whisper 的生产 D1、Durable Object、迁移或 Secret；
- 不要把 Cloudflare API Token 放进任何客户端程序；
- 不要把 Tunnel token 放进 exe、APK、CLI 或网页；
- 不要把 token 写入 Git、日志、截图或命令历史；
- 不要用部署命令覆盖现有 Whisper；
- 不要在没有确认目标账户和 Zone 的情况下创建 DNS 记录；
- 不要把 Cloudflare Workers 当作常驻 Linux 服务器；
- 需要常驻进程时使用独立 Tunnel 或其他明确的服务器方案。

## 现实限制

Whisper 当时的本地 `wrangler whoami` 没有登录，因此账户归属、套餐、Tunnel 权限和实际剩余额度没有通过本地 Wrangler 验证；新项目 Agent 需要先在 Cloudflare 控制台确认账户、Zone 和权限，再创建资源。
