# toolcall-gateway

[![ci-and-publish](https://github.com/kaoqy/tool-calls-gateway/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/kaoqy/tool-calls-gateway/actions/workflows/docker-publish.yml)
[![ghcr](https://img.shields.io/badge/ghcr.io-toolcall--gateway%3Av1.1.1-blue)](https://github.com/kaoqy/tool-calls-gateway/pkgs/container/toolcall-gateway)

> **OpenAI 兼容 · 工具调用模拟** 轻量中转网关。
> 让「只支持纯聊天」的上游模型（如 DeepSeek 纯聊天接口）在不改造下游 Agent / SDK / 客户端的前提下，**变相支持 tool_calls**。

- 运行时：Node.js 20+（ESM，`.mjs`），**零运行时依赖**（只用 `node:` 内置模块 + 全局 `fetch`），无构建步骤。
- 部署：单镜像 `node:20-alpine`，非 root（`USER node`），带 `HEALTHCHECK`，支持 `docker compose up`。
- 无状态：网关不保存任何会话，见 [协议假设](#协议的硬性假设)。

## 🚀 一键部署（3 种方式，选一个）

已发布镜像：`ghcr.io/kaoqy/tool-calls-gateway:v1.1.1`（由 GitHub Actions 在打 `v*.*.*` tag 时自动构建并推送，linux/amd64 + linux/arm64）。

### 方式 A：一条命令（脚本会自动建 `.env`、拉镜像、起容器、等健康检查）

```bash
curl -fsSL https://raw.githubusercontent.com/kaoqy/tool-calls-gateway/main/deploy.sh | sh
# 首次运行会生成 ./toolcall-gateway/.env 并退出；填好 UPSTREAM_BASE_URL / UPSTREAM_API_KEY 后，再跑一次即可
# 第二次会打印自动生成的 ADMIN_TOKEN —— 打开 http://127.0.0.1:8787/admin 输入它即可进设置页
```

### 方式 B：docker compose（生产用预构建镜像）

```bash
git clone https://github.com/kaoqy/tool-calls-gateway.git && cd tool-calls-gateway   # 或只下载 docker-compose.prod.yml
cp .env.example .env && vi .env                          # 填上游地址与密钥
docker compose -f docker-compose.prod.yml up -d
curl -s localhost:8787/healthz                           # {"status":"ok"}
```

### 方式 C：纯 docker run

```bash
docker run -d --name toolcall-gateway \
  -p 8787:8787 \
  -e UPSTREAM_BASE_URL=https://api.deepseek.com \
  -e UPSTREAM_API_KEY=sk-你的密钥 \
  -e DEFAULT_MODEL=deepseek-chat \
  --restart unless-stopped \
  ghcr.io/kaoqy/tool-calls-gateway:v1.1.1

curl -s localhost:8787/healthz
```

> 部署完成后，把下游 SDK 的 `base_url` 指向 `http://<host>:8787/v1` 即可（见 [4. 客户端接入示例](#4-客户端接入示例)）。
> 若设置了 `GATEWAY_API_KEY`，下游需带 `Authorization: Bearer <GATEWAY_API_KEY>`；网关发往上游时始终改用 `UPSTREAM_API_KEY`。

---

## 🖥 应用内设置（不用改 env）

打开 **`http://<host>:8787/admin`**，在网页里改上游并**立即热生效**——不用改 `.env`、不用重启、不用重建容器。

| 分类 | 可改字段 |
| --- | --- |
| 上游 | `upstreamBaseUrl`、`upstreamApiKey`（掩码回显）、`defaultModel`、`modelMap`、`modelOverride` |
| 网关 | `gatewayApiKey`（掩码回显）、`toolMode`、`reasoningPassthrough`、`requestTimeoutMs`、`maxBodyBytes` |

优先级：**UI 保存的设置文件 > 环境变量 > 内置默认值**。每个字段旁边都有来源徽标（`UI 已覆盖` / `来自 env` / `默认值`），不会出现"到底哪个生效"的歧义。

- **密钥不回显**：只返回 `sk-***abcd` 形式的 hint；留空保存 = 不修改，填新值 = 覆盖。
- **测试连接**：用当前表单值（不保存）打一次 `GET /v1/models`，返回状态码、延迟与模型列表。
- **列出模型**：把上游模型列成表格，并标注 `supports_tool_call`（`false` 就说明必须走提示词模拟）。
- **工具模拟自检**：用保存的配置真发一次带 `tools` 的请求（**消耗 1 次上游调用**），直接显示 `finish_reason`、`tool_calls` 数量与参数样例。
- **恢复环境变量默认值**：一键清空所有 UI 覆盖项（删除设置文件）。
- **访问控制**：分两种模式——
  - 本机裸跑（来源是 `127.0.0.1` / `::1`）：**免登录**，直接打开 `/admin`。
  - Docker / 端口映射 / 反向代理（来源是网桥网关或代理 IP）：**必须设置 `ADMIN_TOKEN`**。`deploy.sh` 会自动生成并打印；浏览器打开 `/admin` 输入令牌，服务端下发 `HttpOnly` Cookie（24h），也可直接用 `Authorization: Bearer <ADMIN_TOKEN>` 调 API。
- **持久化**：设置写到 `DATA_DIR/settings.json`（默认 `data/`，权限 0600）。容器部署务必挂 volume（compose 已内置 `tcg-data:/app/data`），否则重建会丢。

> 安全提示：设置页能改上游地址，等价于一个"代理配置"入口，请只在内网暴露或放在带鉴权的反代之后。

## 1. 它解决什么问题

```
下游 Agent/SDK（按 OpenAI 工具调用协议工作）
        │  tools + tool_choice + assistant.tool_calls + role:tool
        ▼
┌─────────────────────────────────────────────┐
│ toolcall-gateway                            │
│  ① 注入系统提示词（把 tools 变成文字约定）      │
│  ② 历史归一化（tool_calls/tool → 纯文本）      │
│  ③ 剥离 tools/function_call/response_format   │
│  ④ 解析模型的 <tool_call> 块 → 标准 tool_calls │
└─────────────────────────────────────────────┘
        │  只发 messages（纯聊天）
        ▼
上游纯聊天模型（OpenAI 兼容 /v1/chat/completions，但不支持 function calling）
```

- **带 `tools`/`functions` 的请求** → 走「模拟模式」：用提示词让模型输出结构化 `<tool_call>` 块，网关解析成标准 `tool_calls` 返回。
- **不带工具的请求** → **字节级透传**：请求体原样发给上游，响应（含 SSE 流）原样返回，零解析、零缓冲。

## 2. 快速开始

### 2.1 本机裸跑（Node 20+）

```bash
cp .env.example .env          # 填 UPSTREAM_BASE_URL / UPSTREAM_API_KEY
node --env-file=.env src/server.mjs
# 或：npm start（配合 shell 里已导出的环境变量）
```

### 2.2 Docker

```bash
docker build -t toolcall-gateway:dev .
docker run --rm -p 8787:8787 --env-file .env toolcall-gateway:dev
curl -s localhost:8787/healthz      # {"status":"ok"}
```

### 2.3 docker compose

```yaml
# docker-compose.yml（已随仓库提供）
services:
  toolcall-gateway:
    build: .
    ports: ["${HOST_PORT:-8787}:8787"]
    env_file: [.env]
    restart: unless-stopped
```

```bash
cp .env.example .env && vi .env
docker compose up -d
curl -s localhost:8787/healthz
docker compose logs -f
docker compose down
```

### 2.4 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `UPSTREAM_BASE_URL` | `https://api.deepseek.com` | 上游 base（可带 `/v1`，网关会避免拼成 `/v1/v1`） |
| `UPSTREAM_API_KEY` | 空 | 上游密钥，**只从环境读，永不写日志** |
| `DEFAULT_MODEL` | 空 | 请求未带 `model` 时使用 |
| `TOOL_MODE` | `auto` | `auto`=含 tools 时模拟；`off`=完全透传（不模拟，上游会因 tools 报错，仅用于排查） |
| `REQUEST_TIMEOUT_MS` | `60000` | 单次上游请求总超时（含流式），超时返回 `504 upstream_timeout` |
| `MAX_BODY_BYTES` | `2097152`（2MB） | 入站请求体上限，超出返回 `413 payload_too_large` |
| `LOG_LEVEL` | `info` | `debug` 会打印注入后的上游 prompt（密钥仍被脱敏） |
| `MODEL_MAP` | 空 | 客户端模型名 → 真实上游模型。支持 JSON `{"gpt-5-codex":"deepseek-web-flash"}` 或 `gpt-5-codex:deepseek-web-flash,gpt-4o:deepseek-web-flash` |
| `MODEL_OVERRIDE` | 空 | **硬覆盖**：任何请求都改写成这个上游模型（优先级最高） |
| `GATEWAY_API_KEY` | 空 | 设置后校验下游 `Authorization: Bearer <key>`；发往上游时始终改用 `UPSTREAM_API_KEY`（客户端 key 不外泄） |
| `REASONING_PASSTHROUGH` | `on` | `on` 时把上游 `reasoning_content`/`reasoning` 原样挂在响应 message（及流式 `delta.reasoning_content`）上，**不并入 content** |
| `LIVE_MODEL` | `deepseek-web-flash` | live 脚本使用的真实模型 |
| `MAX_LIVE_CALLS` | `40` | 每个 live 脚本进程最多打多少次真实上游（超出直接抛错并停止） |
| `LIVE_DELAY_MS` | `1500`/`2000` | live 脚本的请求间隔（节流，避免触发 web 类上游的风控/人机验证） |
| `ADMIN_TOKEN` | 空 | 设置页令牌。设置后 `/admin` 需 `Authorization: Bearer <ADMIN_TOKEN>`；不设则只允许本机回环访问 |
| `DATA_DIR` | `data` | 设置文件目录（`settings.json`，权限 0600）。容器内务必挂 volume |
| `SETTINGS_FILE` | 空 | 直接指定设置文件完整路径，优先级高于 `DATA_DIR` |

## 3. 端点

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/healthz` | 返回 `{"status":"ok"}`（HEALTHCHECK 用） |
| GET | `/v1/models` | 透传上游 |
| POST | `/v1/chat/completions` | 含 `tools`/`functions` → 模拟；否则透传 |
| GET | `/admin` | 设置页（HTML，无外部资源） |
| GET | `/admin/api/settings` | 当前生效配置（密钥掩码）+ 每个字段的来源 |
| PUT | `/admin/api/settings` | 保存并热生效（只接受白名单字段，空值 = 取消覆盖） |
| POST | `/admin/api/settings/reset` | 清除全部 UI 覆盖项，回落 env |
| POST | `/admin/api/test` | 用候选配置测试上游 `GET /models`（不保存） |
| POST | `/admin/api/test-tool` | 用当前配置跑一次工具模拟自检（消耗 1 次上游调用） |
| POST | `/admin/api/login` | 用 `ADMIN_TOKEN` 换登录 Cookie（24h） |
| POST | `/admin/api/logout` | 清除登录 Cookie |

错误统一为 OpenAI 风格：

```json
{ "error": { "type": "upstream_timeout", "message": "上游响应超时" } }
```

常见 `type`：`invalid_json` / `invalid_request_error` / `payload_too_large` / `upstream_timeout` / `upstream_error` / `not_found` / `internal_error`。

## 4. 客户端接入示例

网关对下游而言就是一个 OpenAI 兼容端点，把 `base_url` 指过来即可（密钥随便填非空值，真正的密钥在网关侧）。

### 4.1 curl：带工具

```bash
curl -s http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer any-value' \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role":"user","content":"北京天气怎么样？"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询城市天气",
        "parameters": {"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}
      }
    }]
  }'
```

返回：

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "deepseek-chat",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_…",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"北京\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

### 4.2 curl：不带工具（纯透传）

```bash
curl -s http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

### 4.3 OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="not-needed")

tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "查询城市天气",
        "parameters": {"type": "object",
                       "properties": {"city": {"type": "string"}},
                       "required": ["city"]},
    },
}]

messages = [{"role": "user", "content": "北京天气怎么样？"}]
resp = client.chat.completions.create(model="deepseek-chat", messages=messages, tools=tools)
msg = resp.choices[0].message
print(resp.choices[0].finish_reason)      # tool_calls
print(msg.tool_calls[0].function.name)    # get_weather
print(msg.tool_calls[0].function.arguments)

messages.append(msg)                       # 回传 assistant（含 tool_calls）
messages.append({
    "role": "tool",
    "tool_call_id": msg.tool_calls[0].id,
    "name": msg.tool_calls[0].function.name,
    "content": '{"city":"北京","temp":"25C","text":"晴"}',
})
final = client.chat.completions.create(model="deepseek-chat", messages=messages, tools=tools)
print(final.choices[0].finish_reason)      # stop
print(final.choices[0].message.content)    # 最终自然语言答案
```

### 4.4 OpenAI Node SDK

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://localhost:8787/v1', apiKey: 'not-needed' });

const tools = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询城市天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}];

const messages = [{ role: 'user', content: '北京天气怎么样？' }];
const first = await client.chat.completions.create({ model: 'deepseek-chat', messages, tools });
const call = first.choices[0].message.tool_calls?.[0];

messages.push(first.choices[0].message);
messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: '{"text":"晴"}' });

const second = await client.chat.completions.create({ model: 'deepseek-chat', messages, tools });
console.log(second.choices[0].finish_reason, second.choices[0].message.content);
```

### 4.5 流式（stream: true）

```bash
curl -N http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"北京天气？"}],
       "tools":[{"type":"function","function":{"name":"get_weather","description":"查天气",
       "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}'
```

含工具时收到的是网关**合成**的 SSE（`role` 首包 → 工具首包带 `id/type/name` → `arguments` 分片 → `finish_reason: "tool_calls"` → `data: [DONE]`），与 OpenAI 官方流的形状一致，SDK 可直接消费。

### 4.6 Codex 类应用接入（config.toml）

Codex 用 `wire_api = "chat"` 走 Chat Completions，把 `base_url` 指到网关即可。模型名随便写（例如 `gpt-5-codex`），由网关的 `MODEL_MAP` 映射到真实上游模型：

```toml
# ~/.codex/config.toml
model = "gpt-5-codex"          # 由网关 MODEL_MAP 映射到 deepseek-web-flash
model_provider = "tcgateway"

[model_providers.tcgateway]
name = "ToolCall Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "GATEWAY_API_KEY"    # 网关设置了 GATEWAY_API_KEY 时，Codex 侧填同一个值
wire_api = "chat"
```

对应 `.env`：

```bash
MODEL_MAP={"gpt-5-codex":"deepseek-web-flash","gpt-5":"deepseek-web-flash"}
GATEWAY_API_KEY=local-dev-key
```

请求形状（`scripts/e2e_codex.mjs` 实测的形状）：`stream: true` + `stream_options.include_usage: true` + `tools:[{name:"shell", parameters:{command, workdir, timeout}}]` + 大段系统指令。网关返回的是标准 SSE `tool_calls` 分片（`id/type/name` 首包 → `arguments` 分片 → `finish_reason:"tool_calls"` → `[DONE]`），SDK 可直接消费。

> ⚠️ Codex 的 `apply_patch` 是**自由文本 / grammar 工具**，不是 JSON-schema function，见 6.1 的「已知不支持」。需要改文件时，建议让 Codex 降级用 `shell` 工具（`cat > file <<'EOF'`）完成，或把该工具接到原生工具上游。



## 5. 协议细节

### 5.1 请求改写（客户端 → 上游）

含 `tools`/`functions` 时：

1. 取出 `messages` 做历史归一化（见 5.2）。
2. 在**最前面**注入系统提示词模板，`{{TOOLS_JSON}}` 填入 `tools[i].function` 归一化后的 JSON（旧式 `functions` 同样转换）。
3. 按 `tool_choice` 追加约束句：`required`/`any` → 强制至少调用一次；`{"type":"function","function":{"name":"X"}}` → 强制调用 X；`none` → 禁止调用；`auto` → 不追加。
4. **剥离**：`tools`、`tool_choice`、`functions`、`function_call`、`parallel_tool_calls`、`response_format`，以及任何不在白名单里的字段（上游不认识就报错）。
5. **透传**：`model`、`temperature`、`top_p`、`max_tokens`、`stop`、`presence_penalty`、`frequency_penalty`、`seed`、`stream`、`stream_options`。

> `response_format` 被剥离：多数纯聊天上游不支持 JSON mode；如果需要结构化输出，请让模型直接在正文里输出 JSON。

### 5.2 历史归一化

| 原始 | 归一化后 |
| --- | --- |
| 多条 `system` / `developer` | 按顺序合并成一条，放在注入模板**之前** |
| `user` | 原样保留（多模态 content 只取 text 部分） |
| 普通 `assistant` | 原样保留 |
| 带 `tool_calls` 的 `assistant` | assistant 文本 = 原 content + 每个调用一个 `<tool_call>{"name":…,"arguments":{…}}</tool_call>` |
| `role: tool` | 转成 `user`，内容为 `<tool_result tool_call_id="…" name="…">…</tool_result>`，连续的多个合并成一条 |
| 相邻同角色 | 合并，避免出现连续两条 `user` |

### 5.3 响应解析（上游 → 客户端）

1. 用 `/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi` 提取所有块。
2. 去 markdown 围栏 → `JSON.parse` → 失败则 `repairJson`（去注释/尾逗号、保守单引号转换、截取首个 `{`/`[`、补全括号）后重试。
3. `arguments` 是对象就序列化成字符串（OpenAI 规范要求 string），缺失则 `"{}"`；`id = "call_" + 24 位随机 hex`。
4. `content` = 去掉所有块后的剩余文本（trim），为空且有调用时给 `null`。
5. **有 ≥1 个成功解析的调用** → `finish_reason: "tool_calls"`；**一个都没有** → `finish_reason: "stop"`，正文原样返回（解析失败的块留在 content 里），并打 `warn` 日志。

### 5.4 流式策略（重要）

| 场景 | 策略 | 代价 |
| --- | --- | --- |
| 请求**不含**工具 | **真透传**：上游 SSE 逐块转发，不缓冲、不改写 | 无（与直连上游一致） |
| 请求**含**工具 | **buffer-then-synthesize**：先读完上游整段流 → 拼出完整文本 → 解析 → 按 OpenAI 规范合成 SSE | 首字延迟 ≈ 完整生成时间（TTFB 变差，但正确） |

原因：`<tool_call>` 块可能横跨多个 token 分片，必须先收齐才能判定是「工具调用」还是「普通文本」。

`stream_options.include_usage` 为 true 时，会在 `[DONE]` 前补一个 `choices: []` 且带 `usage` 的 chunk（上游有 usage 才补，没有则省略）。

### 5.5 思考内容（reasoning）隔离

上游若返回 `reasoning_content`（DeepSeek 风格）或 `reasoning`：

- **解析器完全看不到它**：`parseModelOutput` 只接收 `content`，因此思考里出现的 `<tool_call>` 字样不会被当成工具调用。
- **不并入 content**：响应 `message.reasoning_content` 原样透传；`content` 仍按「去掉工具块后的正文」计算，有工具调用且无正文时为 `null`。
- **流式**：合成时先发 `delta.reasoning_content` 分片，再发 content 分片，最后才是 tool_calls 分片；`reasoning` 永不进 content 通道。
- `REASONING_PASSTHROUGH=off` 可整体关闭该字段（例如下游 SDK 不认识额外字段时）。

### 5.6 模型映射

优先级：`MODEL_OVERRIDE`（硬覆盖） > `MODEL_MAP` 命中 > `DEFAULT_MODEL` > 客户端原 model。

- 命中映射时，**响应里的 `model` 字段是实际上游模型**（不是客户端请求的别名），与 OpenAI 行为一致。
- 无工具的透传请求只在「映射确实发生」时才改写 body 的 `model` 一个字段，其余字节原样转发（这也是 G1 逐字节对比能通过的原因：默认不配映射就不改写）。
- `max_tokens` / `max_completion_tokens` / `max_output_tokens` 统一归一化成上游的 `max_tokens`（仅模拟模式；透传模式不改 body）。

## 6. 限制与权衡（务必阅读）

1. **提示词模拟 ≠ 原生 function calling**：模型可能不按格式输出、漏参数、编造工具名、或在 `arguments` 里写坏 JSON。网关有 JSON 修复与「解析失败回退为文本」的兜底，但**不保证 100% 命中**。
2. **建议工具数量少（≤10 个）、schema 简单、描述清晰**。工具太多会挤占上下文并显著降低命中率。
3. **含工具的流式请求首字延迟明显增加**（buffer-then-synthesize，见 5.4）。对延迟敏感的纯聊天场景不要带 `tools`。
4. **无状态**：网关不保存任何会话，正确性依赖客户端每轮都回传完整消息历史（OpenAI 协议默认行为）。
5. `parallel_tool_calls` 会被剥离；模型输出几个块就返回几个 `tool_calls`（不做数量限制）。
6. `response_format` 会被剥离；`n`、`logprobs` 等非白名单字段同样不会透传给上游。
7. `tool_choice: "required"` 时如果首次没命中，会**自动重试一次**（带强化指令）；仍失败则按文本返回 `finish_reason: "stop"`，不报错。
8. 上游的 `usage` 原样透传；上游没有时补 `{0,0,0}`。模拟模式的 prompt 变长了，真实 `prompt_tokens` 会比客户端看到的历史大。
9. **web 类上游有人机验证/限流**：若上游是「网页模型」聚合通道（如本仓库实测的 `deepseek-web-flash`），高频连续调用可能返回 `403 DeepSeek 网页要求重新登录或人机验证`。网关会**原样透传**该 4xx，不会重试或伪造成功；live 脚本把它记为 `BLOCKED_BY_UPSTREAM`（不计为网关失败）。真实生产请用 API 计费通道或加节流/重试策略。

### 6.1 已验证支持 / 已实测不支持的客户端形状

| 形状 | 结论 | 证据 |
| --- | --- | --- |
| 非流式 `tools` + `tool_choice: auto/required/none/{name}` | ✅ 支持 | `conformance --live`（A 组）+ `conformance-dry`（A 组严格） |
| 非流式并行多工具 | ✅ 支持 | `conformance --live` A2 命中 2 个调用 |
| 流式 `stream:true` + `tools` + `stream_options.include_usage` | ✅ 支持（真端点行为受上游影响） | `e2e_codex --live` 拿到 `shell` 流式 tool_calls + usage chunk |
| 多轮：tool → `role:tool` → 终答 | ✅ 支持 | `e2e_live --live` 两轮、`conformance --live` C1/C2 |
| 上游原生 `tool_calls`（结构化） | ✅ 兜底支持（直接转换） | mock `native`/`stream_native` 单测 |
| `reasoning_content` | ✅ 隔离透传 | mock `reasoning`/`stream_reasoning` 单测 |
| **自由文本 / grammar 工具（Codex `apply_patch` 的 freeform 形态）** | ❌ 已知不支持 | `e2e_codex --live` 反向用例：模型只给自然语言/空响应，网关协议层不崩 |
| 非 JSON-schema 的自定义语法工具（如 shell 的 grammar 变体） | ❌ 不支持 | 同上：提示词只能约束 JSON 对象 |
| `n>1`、`logprobs`、`response_format` | ⚠️ 不透传/忽略 | `conformance` E3 + 单测（未知字段剥离） |

### 协议的硬性假设

- 客户端**每次请求都携带完整历史**，包括上一轮的 `assistant.tool_calls` 与 `role: "tool"` 结果。网关不记忆任何东西。
- 客户端会为每个 `tool_calls[i]` 回传对应的 `tool_call_id`；缺失时网关用空字符串，并在能查到映射时补上工具名。
- 上游是 OpenAI 兼容的 `/v1/chat/completions`，`messages` 只认 `system`/`user`/`assistant`。

## 7. 测试与验收

```bash
npm test                  # 单元测试（node --test test/*.test.mjs）
npm run gate              # 离线全量 gate（M0~M6 + M8 + M10-dry；会自起 mock + 网关，真打 HTTP）
npm run gate:live         # 额外跑 M9（真实端点，会消耗额度）
npm run conformance       # 工具调用全量矩阵（默认 dry-run / mock）
npm run conformance:live  # 同上，打真实端点，产出 out/conformance-live.{json,md}
npm run hitrate           # 命中率压测（默认 dry-run，只打印计划）
npm run e2e:codex         # Codex 形状（默认 dry-run）
npm run e2e:codex:live    # Codex 形状（真实端点）
npm run e2e:live          # 真实双轮工具循环（--live）
```

| Gate | 内容 |
| --- | --- |
| G0 | `node --check` 全部 src、`/healthz` 200、单元测试 |
| G1 | 无 tools 的透传基线（非流式/流式/429/`/v1/models` 均与直连 mock 逐字节一致） |
| G2 | 请求改写与提示注入（10 组用例） |
| G3 | 响应解析与非流式合成（12 组用例） |
| G4 | 流式合成（单测 + 真 HTTP SSE e2e） |
| G5 | 健壮性（重试、超时 504、上游 500 透传、400、413） |
| G6 | 端到端两轮工具循环（不依赖 docker） |
| G8 | 协议健壮性：reasoning 隔离 / 原生 tool_calls 兜底 / 参数特殊字符 / max_tokens 别名 / 异常 SSE / 模型映射 / 网关鉴权 + `conformance` dry 矩阵 35 项 |
| G9 | 真实端点：`conformance --live` + `e2e_live --live` + `hitrate --live`（默认跳过，需 `--live`） |
| G10 | Codex 形状（dry 恒跑；`--live` 时再加真实端点） |
| G11 | 应用内设置（8 项存储单测 + 9 项 UI/热生效/鉴权 e2e） |

`mock/upstream.mjs` 是可控的上游替身，通过 `X-Mock-Mode` 头、`?mode=` 或 model 名（`mock-<mode>[-<status>]`）选择模式：

`text` / `tool` / `multi` / `malformed` / `stream_tool` / `error`（`?status=`）/ `slow`（`?delay=`）/ `retry_first` / `time` / `tricky` / `native` / `stream_native` / `reasoning` / `stream_reasoning` / `weird_sse` / `fenced` / `variant` / `special_name` / `emptyargs` / `loop` / `multi_loop`。

`/__diag` 会返回网关实际发到上游的请求签名（model / keys / authPrefix 前 16 字符），用于断言"字段被剥离、key 被覆盖"，且不参与响应体对比。

## 8. 真实上游联调

```bash
# 双轮工具循环（真实工具：get_time + read_file），默认 dry-run
node scripts/e2e_live.mjs --live

# 打印注入后的完整上游 prompt（排错用，密钥已脱敏）
LOG_LEVEL=debug node scripts/e2e_live.mjs --live

# 全量矩阵 + 命中率
node scripts/conformance.mjs --live
node scripts/hitrate.mjs --live --runs 8
```

脚本行为（`e2e_live.mjs`）：起网关 → 第 1 轮带 `tools` 请求 → 本地执行 `get_time` / `read_file` → 回传 `role:tool` → 断言最终 `finish_reason:"stop"` 且有文本答案，打印 `E2E LIVE: PASS/FAIL` 与耗时。

- 没有 `UPSTREAM_API_KEY` → 退出码 2（SKIP）。
- 上游 4xx（人机验证/限流）→ 退出码 3（BLOCKED），gate 记为 SKIP 而不是 PASS。
- 所有 live 脚本共享 `MAX_LIVE_CALLS`（默认 40）与 `LIVE_DELAY_MS` 节流；默认 dry-run，只有 `--live` 才真打。

## 9. 目录结构

```
toolcall-gateway/
├─ package.json            # type: module，零依赖
├─ Dockerfile              # 多阶段，node:20-alpine，USER node，HEALTHCHECK
├─ docker-compose.yml
├─ .env.example
├─ .dockerignore
├─ src/
│  ├─ server.mjs           # http 服务 + 路由 + 鉴权 + 透传/模拟分支
│  ├─ config.mjs           # 环境变量 + MODEL_MAP 解析/模型映射
│  ├─ settings.mjs         # 应用内设置：校验/持久化/热生效/密钥脱敏
│  ├─ admin-ui.mjs         # 设置页 HTML（单文件，零外部资源）
│  ├─ upstream.mjs         # 调上游（超时/错误分类）
│  ├─ prompt.mjs           # buildUpstreamRequest：注入 + 归一化 + 剥离
│  ├─ protocol.mjs         # parseModelOutput / repairJson / 原生 tool_calls / 合成响应与 SSE
│  ├─ sse.mjs              # SSE 读写（容忍异常框架、收集 reasoning/原生 tool_calls）
│  └─ logger.mjs           # 级别过滤 + 密钥脱敏
├─ test/                   # scaffold / prompt / protocol / streaming / robustness / robustness-protocol
├─ mock/upstream.mjs       # 可控上游替身（含 /__diag）
├─ scripts/
│  ├─ gate.mjs             # 一键 gate（M0~M10，--live 才跑 M9）
│  ├─ conformance.mjs      # 工具调用全量矩阵（dry / --live）
│  ├─ hitrate.mjs          # 命中率 + P50/P95（dry / --live）
│  ├─ e2e_live.mjs         # 真实多轮工具循环
│  ├─ e2e_codex.mjs        # Codex 形状（正向 + apply_patch 反向）
│  ├─ e2e_passthrough.mjs / e2e_stream_tool.mjs / e2e_mock.mjs
│  └─ lib/harness.mjs · lib/live.mjs   # 子进程/HTTP/额度/报告/脱敏
├─ out/                    # live 报告的 JSON/Markdown（运行时生成）
├─ data/                   # settings.json（设置页保存的覆盖项，0600；运行时生成）
└─ LEDGER.md               # 里程碑账本（含每轮 gate 的真实输出）
```

## 10. 安全

- `UPSTREAM_API_KEY` 只在 `src/upstream.mjs` 里以 `Authorization` 头使用；日志经 `logger.redact()` 脱敏（`authorization`/`api_key`/`token`/`secret`/`password` 一律输出 `[REDACTED]`）。
- 容器内以 `node` 用户运行，不带任何构建工具链。
- 入站请求体大小受限（`MAX_BODY_BYTES`），避免被大包打爆内存。
- 网关**不是**多租户鉴权层：请只在内网 / 反代后面暴露，或自行在反代上做鉴权。
- 设置页默认只允许本机回环访问；远程访问需 `ADMIN_TOKEN`。设置文件含上游密钥，权限 0600（Windows 上 chmod 不生效，依赖目录 ACL / 磁盘加密）。
- 设置页能改上游地址，等价于 SSRF 入口：只给可信的人访问。

## 11. 发布与 CI（GitHub Actions）

工作流：`.github/workflows/docker-publish.yml`，触发条件：

| 事件 | 行为 |
| --- | --- |
| `pull_request` | 只跑测试（Node 20/22 矩阵、`npm test`、`npm run gate`、密钥扫描），不推镜像 |
| push 到 `main` | 测试 → 构建并推送 `ghcr.io/<owner>/<repo>:latest` 与 `sha-xxxxxxx` → 镜像冒烟（起容器验 `/healthz` 与 `USER node`） |
| push tag `v1.1.1` | 同上，并额外推送 `:v1.1.1`、`:1.1.1`、`:1.0` |

发布一个版本（本项目当前版本即 `v1.1.1`）：

```bash
git tag v1.1.1
git push origin v1.1.1     # 触发构建，产出 ghcr.io/<owner>/<repo>:v1.1.1
```

镜像为多架构（`linux/amd64` + `linux/arm64`），带 SBOM 与 provenance。GHCR 使用内置 `GITHUB_TOKEN`（`packages: write`），无需额外 secret。

> 想同时推到 Docker Hub？在仓库 Secrets 里加 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`，并在工作流里加一个 `docker/login-action` 步骤即可（默认未启用）。

## 12. 维护者检查清单（发布前）

```bash
npm test            # 单元测试（含设置存储）
npm run gate        # 离线全量 gate（M0~M6 + M8 + M10 + M11）
npm run conformance # 35 项协议矩阵（mock 确定性）
npm run e2e:codex   # Codex 形状（dry）
```
