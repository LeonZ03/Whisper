# 实时同步 v1（实施契约）

本次接续未发布的 Linux CLI 改动。消息和身份仍由原有数据库及加密协议管理；WebSocket 只提示需要同步，不携带消息、图片、联系人或会话标识。

## 接口

- `/api/health` 增加能力 `realtime-sync-v1`。
- `POST /api/realtime/ticket`：原有会话 cookie 和写入来源校验，返回 `{ticket, expiresAt}`。随机一次性票据有效期 60 秒，只用于建立当前会话的连接，不写客户端文件。云端票据哈希保存在 SQLite Durable Object；本机保存在内存。
- `GET /api/realtime`：WebSocket 升级，子协议为 `whisper-realtime-v1` 和 `ticket.<ticket>`，仅回显前一个协议。票据不进入 URL、命令行或日志；原始会话 cookie 不交给 Android JavaScript。握手原子消费票据并再次检查原会话有效性。浏览器来源为本站，Android 来源固定为 `https://appassets.androidplatform.net`，Node 客户端可无 Origin；任意其他 Origin 拒绝。
- 连接后发 `{type:"ready", version:1}`；数据提交后的通知为 `{type:"changed", version:1}`。每次发送前检查会话仍有效；撤销时关闭旧连接。无客户端会话订阅参数，因此不能指定他人账号。通知只是授权账号的失效提示，具体内容仍经同步接口的参与权限检查。
- 心跳：客户端每 45 秒发字符串 `ping`，服务端回 `pong`。DO 使用 `acceptWebSocket` 和 `setWebSocketAutoResponse`；没有扫描数据库的常驻计时器。心跳只检测传输，不延续会话有效期。
- `GET /api/sync?conversationId=<uuid>&cursor=<整数>`。两个参数均可省略；省略 cursor、游标超过高水位或落后于保留范围时返回快照 `reset:true`。选中会话改变时须丢弃游标并请求快照。没有选中会话时只同步会话列表。
- 返回 `{version:1,cursor,reset,more,conversationId,conversations,removedConversations,messages,removed,serverTime}`。conversations 使用原有会话对象；messages 使用原有消息 envelope（图片密文及 nonce 始终为 null）；removed 和 removedConversations 为 ID 数组。reset 时替换会话列表及所选会话消息（最近 200 条），增量时按 ID 合并更新/删除，保留已加载旧页。失效或封存的所选会话返回 conversationId:null，清空内容。
- 游标与数据必须来自同一数据库批次的稳定视图。分页最多 200 条 journal 事件，more:true 时串行继续补拉。游标提交必须发生在当前代的响应被成功应用之后；重复通知合并，旧账号/旧会话/旧请求结果不能覆盖新状态。

## 持久变更记录与通知

新增版本化迁移 0005：有界元数据 journal（至多 10,000 条），以 SQLite 触发器在同一事务记录新增、删除、领取、会话创建/封存/重新打开、身份或状态变化。不得包含额外消息密文、图片、凭据或 IP；原有图片 DELETE RETURNING 原子领取不变。到期由既有绝对时间驱动，后台清理也产生删除记录。快照与增量都再次校验当前成员资格、状态及 history_from_seq。

写接口提交后触发通知。通知异常不得改变成功的写入结果。账号操作触发连接复核，撤销连接不再接收变化通知；不能依靠前台主动退出保证撤销。通知遗漏由每 60–90 秒一次的增量校验及重连补拉恢复。正常连接停用旧高频轮询；断线使用 30–45 秒备用同步，重连指数退避并抖动，上限 60 秒；网络恢复可以立即重试一次。前后台变化暂停/恢复连接，恢复先补拉。

## 实施分工

- 后端：云端/本机接口、journal、DO、权限和限流，以及隔离后端测试。
- 共用网页/App：`src/app.mjs`、`src/realtime-client.mjs`、Android 桥接及生命周期、相关测试。共享连接控制器导出 `RealtimeConnection`，构造参数 `{request, url, onChange, onState, WebSocketImpl=globalThis.WebSocket}`；方法 `start()`, `stop()`, `reconnect()`；状态回调字符串 `connecting`/`open`/`closed`。request 采用 `(path,method,body)`；url 为 WebSocket 地址。控制器负责票据、心跳、重连及低频 onChange，onChange 由调用方串行执行并去重。stop 清除全部定时器与连接。
- CLI：消费以上协议与控制器，保留终端、身份和受保护登录，覆盖 Windows/Linux；只修改 cli 及其专项测试。
- 主任务：接口审查、发布打包、Linux 安装收尾、文档、集成验证与发布。共享输出的构建和完整测试串行进行。

新增 D1 迁移已在隔离数据库验证既有写接口和回滚兼容性，2026-09-29 经所有者单独批准后应用并完成正式发布。具体迁移、提交、线上验收与真机待办记录在 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 已核实的免费套餐能力

2026-09-29 查阅官方文档：SQLite Durable Objects 可用于 Workers Free；支持 WebSocket 休眠，符合休眠条件的空闲连接不计持续执行时间。DO 免费额度包括每天 100,000 请求、13,000 GB-s，SQLite 每天 5,000,000 行读/100,000 行写、共 5 GB；D1 自身也有每天 5,000,000 行读/100,000 行写、共 5 GB 的额度。额度是账号共享限制，不是本站并发人数承诺。出站 WS 消息不计请求费，入站消息按 20:1 计请求；自动心跳回应不唤醒对象执行。新增 journal 增加写入和索引开销，需测量。

来源：[DO 计量](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[WebSocket 休眠](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[D1 计量](https://developers.cloudflare.com/d1/platform/pricing/)、[Workers 计量](https://developers.cloudflare.com/workers/platform/pricing/)。

## 2026-09-29 隔离对比结果

同一 Windows 主机上的 workerd / D1 临时库，使用两个合成账号、预置 200 条加密消息；发送端走 CLI 的发送前身份校验，接收端旧版每两秒轮询，新版使用真实 WebSocket。先测接收端空闲 60 秒，再按相同时间表在 60 秒内发送 30 条消息。计时终点为接收客户端取得并解密消息模型，不是浏览器像素呈现；不代表互联网、手机或正式云端延迟。

| 指标 | 改造前 | 0.6.0 |
| --- | ---: | ---: |
| 发送至确认：中位数 / P95 | 87 / 91 ms | 49 / 65 ms |
| 发送至接收解密：中位数 / P95 | 681 / 1,178 ms | 107 / 125 ms |
| 空闲 60 秒 API 请求 | 60 | 0 |
| 空闲 60 秒 D1 行读 / 行写 | 6,420 / 0 | 0 / 0 |
| 聊天 60 秒 API 请求 | 209 | 91 |
| 聊天 60 秒 D1 行读（含 DO 会话验证） | 14,571 | 4,617 |
| 聊天 60 秒 D1 行写 | 210 | 330 |

本场景聊天请求减少约 56%，D1 读取减少约 68%；新增变更记录使行写增加约 57%。D1 数字来自本机 D1 返回的 `meta.rows_read/rows_written`，包括写入后的通知查询，另加 DO 实际会话验证 60 行读取。调试时曾发现参与者覆盖索引导致旧 journal 全扫描，现按主键范围读取；200 多条历史后新增一条的独立 D1 回归实测仅读取 1 行。

新增组件在聊天阶段处理 30 次 DO 内部通知请求、60 行 D1 会话验证、1 条自动心跳；DO SQLite 在这段已建立连接的聊天期间为 0 行读 / 0 行写。空闲阶段为 1 条自动心跳、0 次 DO 代码请求、0 行数据库读写。建连时的票据插入、消费与认证检查不在这两段窗口内，重连会再次产生这些消耗；正式计费的 CPU、GB-s、持久连接规模尚未实测。正常连接仍每 60–90 秒补拉一次，所以“空闲 60 秒为 0”不表示长期无请求。若全天保持前台，单个客户端仅补拉约 960–1,440 次 / 日，另有发送、认证、重连与已有定时清理消耗。

样本 journal 未达到 10,000 条；满额后淘汰旧事件及消息到期清理会增加写入。不能把请求下降倍数当作容量提升倍数，也不能据此承诺同时在线人数。既有账号、消息和存储上限均未改变；未升级套餐或启用付费产品。当前账号套餐 API 因读取权限不足未独立核验，免费可用能力与额度依据上述官方文档。

复测工具为 `node scripts/benchmark-realtime.mjs`。`--baseline` 需要改造前保存在忽略目录 `.runtime/realtime-baseline/` 的 Worker 和 CLI bundle，不能用新版冒充基线；本轮基线在开始修改前从现有工作区保存。`--diagnostic` 只测三条合成消息以定位 SQL，不能用它代替上表。临时库和安装目录自动清理，机器报告仅写入忽略的 `test-results/`。
