# Sub2API 分组模型自动同步

> 让 OpenClaw 使用的模型**跟随 Sub2API 里该 Key 所属分组的模型**，不必再手写模型名。
> 本页是可选配套工具，与 QQ 渠道本身无关；不装也能正常收发消息。

## 为什么需要

Sub2API 的 Key 属于某个分组，分组决定这个 Key 能请求哪些模型。手工把模型名写进
`openclaw.json` 后，一旦管理员改了分组或分组模型，机器人就会继续请求旧模型，
表现为上游 `404 model_not_found` 或日志里的 `ingress_reject_reason=model_not_allowed`。

同步机制把这个映射自动化：**分组的模型是唯一事实来源**。

## 两种落地方式

| 方式 | 触发时机 | 适用场景 |
| --- | --- | --- |
| 脚本 `scripts/sync-sub2api-models.mjs` | 手动 / cron / systemd timer | 只需要配置跟随，不需要每轮实时校验 |
| 插件 `@ai-proxy-kit/openclaw-sub2api` | 每轮模型解析前 + 后台定时刷新 | 换组后**下一句**就生效，无需重启 |

两者语义一致，可以同时使用（脚本兜底，插件实时）。

## 脚本用法

零依赖，Node 20+ 即可运行：

```bash
node scripts/sync-sub2api-models.mjs            # 同步一次
node scripts/sync-sub2api-models.mjs --dry-run  # 只看计划，不写文件
node scripts/sync-sub2api-models.mjs --check    # CI/巡检：已同步=0，未同步=1
node scripts/sync-sub2api-models.mjs --json     # 机器可读输出
node scripts/sync-sub2api-models.mjs --restart  # 写完后重启 openclaw-gateway
```

| 选项 | 说明 |
| --- | --- |
| `--home <dir>` | OpenClaw 主目录，默认 `$OPENCLAW_HOME` 或 `~/.openclaw` |
| `--provider <name>` | `models.providers` 下的键名，默认 `sub2api` |
| `--base-url <url>` | 覆盖 provider 的 `baseUrl` |
| `--key-env <NAME>` | 存放 Key 的环境变量名，默认取 `provider.apiKey.id`，否则 `SUB2API_API_KEY` |
| `--timeout-ms <n>` | HTTP 超时，默认 5000 |

退出码：`0` 成功/已是最新，`1` `--check` 发现不一致，`2` 发现或写入失败。

## 发现顺序（两级）

1. `GET {baseUrl}/sub2api/key-group` —— 需要 Sub2API 打过后端补丁。返回分组平台、
   别名、修订号等权威元数据，据此选择传输协议（`openai-completions` /
   `anthropic-messages` / `google-generative-ai`）。
2. 该端点返回 `404/405/501` 时，回退到标准 `GET {baseUrl}/models`。Sub2API 已按
   Key 的分组白名单过滤，因此**恰好一个**模型 id 时同样可信；回退一律使用
   `openai-completions` 与原 `baseUrl`。

`5xx` 等真实上游错误**不会**触发回退，避免把服务故障误判成"端点不存在"。

## 歧义语义

`/models` 返回 0 个或 ≥2 个 id，说明该 Key 未绑定单模型分组。此时工具**不写入、
不改配置**，直接报 `ambiguous model list`（脚本）或标记为歧义并停止每轮覆盖（插件）。
理由：随机挑一个模型可能挑到上游已经不可用的目标，比保持现状更危险。

想让机器人自动跟随，请在 Sub2API 把该 Key 归入只含一个模型的分组。

## 写回内容

- `models.providers.<provider>.models` —— 归一后的单个模型条目（保留同 id 已有条目里的
  `contextWindow`/`maxTokens` 等元数据）
- `agents.defaults.models` —— `sub2api/<id>` 条目，清理旧的 `sub2api/*` 具体条目
- `agents.defaults.model.primary` / `fallbacks`
- 旧版每 agent 目录 `agents/<id>/agent/models.json`（仅当它钉了别的模型时才重写）

写入是原子的（临时文件 + `rename`），权限保持 `0600`，改动前生成
`<文件名>.bak-<UTC 时间戳>` 备份。无变化时不写文件。

## 定时任务

```ini
# /etc/systemd/system/openclaw-model-sync.service
[Unit]
Description=Sync OpenClaw model with the Sub2API key group
After=network-online.target

[Service]
Type=oneshot
Environment=OPENCLAW_HOME=/root/.openclaw
EnvironmentFile=/root/.openclaw/.env
ExecStart=/usr/bin/node /root/.openclaw/bin/sync-sub2api-models.mjs --check
```

```ini
# /etc/systemd/system/openclaw-model-sync.timer
[Unit]
Description=Check the OpenClaw model against the Sub2API key group

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
```

用 `--check` 时未同步会以退出码 1 结束，配合 systemd 告警或 `OnFailure=` 即可发现漂移；
想自动修复就去掉 `--check`。

## 排错

| 症状 | 检查 |
| --- | --- |
| `model_not_found` / `model_not_allowed` | 配置里的 `primary` 是否还是旧模型；`/v1/models` 现在返回什么 |
| `ambiguous model list` | 该 Key 的分组是否只允许一个模型 |
| `discovery failed` | `baseUrl` 是否可达、Key 是否有效、IP 白名单是否放行本机 |
| 改完不生效 | 插件模式看网关日志是否 `key-group metadata is unavailable`；脚本模式确认 `--restart` 或手动重启网关 |

> 排错时不要把 Key、token、cookie 贴进终端历史或 Issue；用 `-o /dev/null -w '%{http_code}'`
> 只看状态码。
