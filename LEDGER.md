# LEDGER

> 项目：`toolcall-gateway/`（与同级旧项目「DeepSeek 快速注册」完全独立：旧项目的 `main.py` / `web_server.py` / `.env` / `tests/` / `web/` 等一律未改动、未删除、未覆盖）。
> 断点续跑规则：新会话先读本文件 + `git status`，已完成 `[x]` 的不要重做，从第一个未完成项继续。

## 0. 环境探测（M0 之前）

| 项 | 结果 |
| --- | --- |
| 工作目录 | `C:\Users\Administrator\Documents\DS2Api`（旧 Python 项目所在目录，新项目放 `toolcall-gateway/`） |
| `git` | ❌ 不可用：`git : 无法将“git”项识别为 cmdlet...`（`CommandNotFoundException`）→ 无法用 git 做分支/回滚，改为「纯目录 + 账本」方式管理 |
| `docker` / `docker compose` | ❌ 不可用：`docker : 无法将“docker”项识别为 cmdlet...`（`CommandNotFoundException`） |
| `node` | ✅ v24.22.2（代码按 Node 20 语法写，容器内用 `node:20-alpine`） |
| `npm` | ⚠️ `npm.ps1` 被执行策略禁止（`PSSecurityException`）→ 统一用 `npm.cmd` 调用，脚本本身仍是 `npm test` / `npm run gate` |

## 状态总览

| 里程碑 | 状态 | 最近更新时间 | 备注 |
| --- | --- | --- | --- |
| M0 脚手架 | ✅ | 2026-11-14 22:44 +08 | G0 自动通过（4 项）；`npm test` 4/4 |
| M1 透传基线 | ✅ | 2026-11-14 22:47 +08 | G1 自动 4/4（逐字节一致） |
| M2 请求改写 + 提示注入 | ✅ | 2026-11-14 22:48 +08 | G2 10/10 |
| M3 响应解析 + 非流式合成 | ✅ | 2026-11-14 22:49 +08 | G3 12/12 |
| M4 流式合成 | ✅ | 2026-11-14 22:51 +08 | G4 单测 6/6 + e2e 3/3 |
| M5 健壮性与策略 | ✅ | 2026-11-14 22:52 +08 | G5 7/7 |
| M6 Docker 化 + 文档 | ✅（自动部分） | 2026-11-14 22:53 +08 | G6 通过；README/Dockerfile/compose 已写 |
| **M8 协议健壮性补齐** | ✅ | 2026-11-15 09:10 +08 | G8：单测 51/51 + conformance dry 35/35 |
| **M9 真实联调** | ⚠️ 已实测后受阻 | 2026-11-15 09:22 +08 | 09:10–09:22 真实端点全绿（e2e/conformance/hitrate 均 PASS）；09:24 起上游 403 人机验证，复跑转 SKIP |
| **M10 Codex 形状** | ✅ | 2026-11-15 09:22 +08 | G10：dry PASS + live PASS（shell 命中） |
| **M11 应用内设置** | ✅ | 2026-11-15 12:50 +08 | G11：8 存储单测 + 9 项 UI/热生效/鉴权 e2e 全绿 |
| G0-docker 手动 | ✅ | 2026-11-15 12:11 +08 | **改由 GitHub Actions 验证**：run 43675461000 的 smoke job 真 build 镜像 + 起容器 /healthz + `USER node` 校验全通过 |
| G6-docker 手动 | ✅ | 2026-11-15 12:11 +08 | 同一 CI：多架构镜像推 GHCR + 容器健康检查；本机仍无 docker，compose 起停由镜像冒烟等价覆盖 |
| M7 真实上游联调 | ✅→⚠️ | 2026-11-15 09:22 +08 | 已跑通真实双轮循环；后续复跑被上游风控拦截（详见 M9） |

**当前状态：M0~M6 全部自动 gate 绿灯（`GATE RESULT: PASS (7/7)`）；docker 相关与真实上游两项因环境限制未验证，已在第 5 节列明原因与复现命令。**

## 详细记录

### M0

- [x] G0 自动：`node --check src/*.mjs` + 起服务 `GET /healthz` 200 `{"status":"ok"}` + `npm test`
  - 命令：`node scripts/gate.mjs M0`
  - 输出摘要（exit 0）：
    ```
    $ node --check src/config.mjs    ok
    $ node --check src/logger.mjs    ok
    $ node --check src/server.mjs    ok
    $ node --check src/sse.mjs       ok
    GET /healthz -> 200 {"status":"ok"}
    $ node --test test/scaffold.test.mjs
    ℹ tests 4  ℹ pass 4  ℹ fail 0
    GATE M0 PASS
    ```
  - `npm test`（= `node --test test/*.test.mjs`）4/4 通过。
- [ ] G0-docker 手动：**未验证**
  - 原因：本机没有 docker（`docker version` → `CommandNotFoundException`，无 daemon）。
  - 复现命令：
    ```bash
    cd toolcall-gateway
    docker build -t toolcall-gateway:dev .
    docker run --rm -p 8787:8787 --env-file .env toolcall-gateway:dev
    curl -s localhost:8787/healthz     # 期望 {"status":"ok"}
    docker inspect --format '{{.Config.User}}' toolcall-gateway:dev   # 期望 node
    ```
  - Dockerfile 已按「多阶段 / `node:20-alpine` / `USER node` / `EXPOSE 8787` / `HEALTHCHECK` 请求 `/healthz` / `CMD node src/server.mjs` / 零依赖」写好，但**未经过实际 build 验证**。
- 备注 / 失败原因 / 修复记录：
  - `npm test` 最初写成 `node --test test/`，Node 24 把它当文件加载 → `MODULE_NOT_FOUND`。改为 `node --test test/*.test.mjs`（Node 内部展开 glob）后通过。
  - 新增 `test/scaffold.test.mjs` 作为长期脚手架自检（配置默认值/env 覆盖/日志脱敏/SSE 往返），覆盖 M0 的占位断言要求。

### M1

- [x] G1 自动：`node scripts/e2e_passthrough.mjs`（非流式 / 流式 / 429 / `/v1/models`）
  - 命令：`node scripts/gate.mjs M1`
  - 输出（exit 0）：
    ```
    PASS  ① 非流式响应体逐字节一致
    PASS  ② 流式 chunk 序列与直连 mock 一致
    PASS  ③ 上游 429 原样透传状态码与 body
    PASS  ④ /v1/models 透传一致
    GATE M1 PASS: 4/4 项通过
    ```
- 备注 / 失败原因 / 修复记录：
  - 首轮 3 项失败，两个根因：
    1. `callUpstreamJson` 对 `Buffer` 做了 `JSON.stringify`，请求体变成 `{"type":"Buffer","data":[...]}` → 上游看不到 messages/stream（表现为流式空响应、429 变 200、echo 里 `messages_count=0`）。修复：`body instanceof Uint8Array ? body : JSON.stringify(body)`，真正字节级透传。
    2. mock 的 `echo` 里回显了 `auth_present`（网关自己加的 `Authorization` 头），造成「响应体不一致」的假阳性。修复：去掉 echo 中的鉴权字段（header 不属于 body）。
  - 设计说明：网关不转发 query/自定义头，e2e 统一用 **model 名**（`mock-text` / `mock-error-429`）让 mock 选模式，直连与经网关使用完全相同的 body，保证逐字节可比。

### M2

- [x] G2 自动：`node --test test/prompt.test.mjs`（10 组用例）
  - 命令：`node scripts/gate.mjs M2`
  - 覆盖：单工具注入（system 与期望字符串**逐字相等**，含完整 `<tools>` 与规则文本）/ assistant.tool_calls → `<tool_call>` 块 / tool 消息 → `<tool_result tool_call_id= name=>` / 连续 tool 合并为一条 user（且全局无连续两条 user）/ 多 system（含 `developer`）合并且排在模板前 / `tool_choice` = required·any·`{name:X}`·none·auto 的后缀句 / 上游 body 不含 `tools,tool_choice,functions,function_call,parallel_tool_calls,response_format,unknown_field` / `model,temperature,top_p,max_tokens,stop,presence_penalty,frequency_penalty,seed,stream,stream_options` 透传且 `n` 被丢 / 无 tools 时 `simulated=false` 且 body 原样 / 归一化边界（arguments 坏 JSON 原样嵌入字符串、缺 name 留空、空 tool_calls 不产生块）
  - 结果：`ℹ tests 10  ℹ pass 10  ℹ fail 0`，`GATE M2 PASS`
- 备注 / 失败原因 / 修复记录：
  - 用例 4 第一次失败：过滤 `<tool_result` 时把注入的 system 模板（模板里本身提到 `<tool_result>`）也算了进去。修复：只统计 `role === 'user'` 的消息。

### M3

- [x] G3 自动：`node --test test/protocol.test.mjs`（12 组用例，逐条断言精确 JSON）
  - 命令：`node scripts/gate.mjs M3`
  - 覆盖：纯文本 → content=你好 无 tool_calls finish=stop / 单块（id 匹配 `^call_[0-9a-f]{24}$`、arguments 为字符串 `{"city":"北京"}`、content=null、finish=tool_calls，且 `buildChatCompletion` 输出与 2.5 节结构 deepEqual）/ 两并列块顺序 / 前后带文本 trim / ```json 围栏 / 尾逗号修复 / `{bad}` 回退文本不崩溃（content 含原块，failed=1）/ 缺 arguments → `"{}"` / 中文与嵌套对象原样 / 空块忽略 / 流式 chunk 合成（首包 role、工具首包 id+type+name、arguments 分片拼回、finish、usage 包）/ 纯文本分片拼回
  - 结果：`ℹ tests 12  ℹ pass 12  ℹ fail 0`，`GATE M3 PASS`
- 备注 / 失败原因 / 修复记录：
  - `buildSseChunks` 里 usage 包原本写成 `chunk([]) && {...}`（运算符误用），已改为直接 push `{choices: [], usage}`。
  - 首版流式合成在「有工具调用」时**丢掉了块前正文**（`content` 只在无工具分支输出）。修复后顺序为 `role` → `content` 分片 → 工具调用分片 → finish，与 OpenAI 形状一致（该 bug 由 M4 的 e2e 断言暴露）。

### M4

- [x] G4 自动：`node --test test/streaming.test.mjs` + `node scripts/e2e_stream_tool.mjs`
  - 命令：`node scripts/gate.mjs M4`
  - 单测（6/6）：SSE 事件跨 chunk 边界（含 CRLF 与 `: keep-alive`）/ `collectStreamText` 拼 content+取 usage/model+忽略坏行 / 多工具 index 递增且各自 arguments 独立拼回 / emoji+CJK 参数按码点切分拼回一致 / `includeUsage` 开关 / `encodeSse` 严格 `data: ` 行
  - e2e（3/3，真 HTTP SSE）：
    ```
    PASS  ① stream_tool：role 首包 + 工具首包(id/type/name) + arguments 拼接 + finish + [DONE]
    PASS  ② 纯文本流：delta.content 拼回原文，finish_reason=stop
    PASS  ③ malformed 块：流式场景回退为文本 stop，不崩溃
    ```
    ①里额外断言：`arguments` 分片确实分多包（≥2 个 chunk 带 tool_calls）、`finish_reason=tool_calls` 恰好 1 个、`include_usage` 时有 `choices: []` 的 usage 包、块前正文 `好的，我来查一下。` 也照常流出。
- 备注 / 失败原因 / 修复记录：
  - 首轮失败 ①「没收到 usage chunk」→ mock 的流本来不发 usage；给 mock 补了 `stream_options.include_usage` 支持（更接近真实上游行为）。
  - 首轮失败 ②「文本只切了 1 片」→ 正文太短（13 字）且分片阈值 48。把 mock 的纯文本样本加长到 50+ 字，验证多片。
  - 顺带修复 M3 记录里的「工具场景丢 content」问题。

### M5

- [x] G5 自动：`node --test test/robustness.test.mjs`（7 组用例）
  - 命令：`node scripts/gate.mjs M5`
  - 覆盖：
    1. `tool_choice: "required"` + mock `retry_first`（首次纯文本、第二次给工具）→ 网关带强化指令重试一次 → 最终 `finish_reason=tool_calls`、`content="好的，我来查一下。"`、id 合法
    2. 两次都只有文本 → `finish_reason=stop`、content 为文本、无 tool_calls、HTTP 200（不报错）
    3. 上游 `slow`（3s）+ `REQUEST_TIMEOUT_MS=700` → 客户端 504 + `{"error":{"type":"upstream_timeout",...}}`
    4. 上游 500 → 状态码 500 与 body（`upstream_internal_error` + 原始 message）原样透传
    5. 缺 `messages` → 400 `invalid_request_error`
    6. body 4KB + `MAX_BODY_BYTES=1024` → 413 `payload_too_large`
    7. 非法 JSON → 400 `invalid_json`
  - 结果：`ℹ tests 7  ℹ pass 7  ℹ fail 0`，`GATE M5 PASS`
- 备注 / 失败原因 / 修复记录：
  - 用例 1 首次断言 `content===null` 失败：mock 的工具回复块前有 `好的，我来查一下。`，按 2.4 节规则 content 保留 trim 后的正文 → 断言改为期望该文本（实现符合规范，是测试期望写错）。
  - 413 场景原实现 `req.destroy()` 可能把响应切断，改为 `sendError(413)` 后 `req.resume()` 丢弃剩余数据。

### M6

- [x] G6 自动：`node scripts/e2e_mock.mjs`（端到端两轮工具循环，不依赖 docker）
  - 命令：`node scripts/gate.mjs M6`
  - 输出（exit 0）：
    ```
    第 1 轮: finish=tool_calls tool=get_time args={"timezone":"Asia/Shanghai"} id=call_f8a93c80e9b1e253c6b0a501
    本地执行工具 get_time → {"timezone":"Asia/Shanghai","now":"2026/11/14 22:55:23"}
    第 2 轮: finish=stop content=现在是 2026-11-14 22:50（Asia/Shanghai，模拟时间）。
    第 2 轮 usage={"prompt_tokens":7,"completion_tokens":11,"total_tokens":18}
    E2E MOCK: PASS
    ```
  - 两轮之间脚本把 `assistant(tool_calls)` 与 `role: tool` 结果回传，第二轮的 `finish_reason=stop` 证明「历史归一化 → 上游能理解 tool 结果」这条链路成立。
- [ ] G6-docker 手动：**未验证**
  - 原因：本机无 docker（同 G0-docker）。
  - 复现命令：
    ```bash
    cd toolcall-gateway
    cp .env.example .env    # 填 UPSTREAM_BASE_URL / UPSTREAM_API_KEY
    docker compose up -d
    curl -s localhost:8787/healthz          # 期望 {"status":"ok"}
    docker compose ps                       # 期望 healthy
    docker compose down
    ```
- 备注：README.md（架构/环境变量/curl/Python SDK/Node SDK/流式/两轮循环/限制与权衡/目录结构/安全）、Dockerfile、docker-compose.yml、.env.example、.dockerignore 均已完成。

### M7

- [x] G7 手动：真实上游双轮工具循环（2026-11-15 09:10 +08）
  - 模型：`deepseek-web-flash`（`supports_tool_call:false`、`supports_reasoning:true`），base `https://agent2api.china-ai.top/v1`
  - 输出：
    ```
    第 1 轮 (2955ms): finish=tool_calls tool_calls=2 [get_time, read_file]
        → get_time({"timezone":"Asia/Shanghai"}) = {"timezone":"Asia/Shanghai","now":"2026/11/15 09:10:40"}
        → read_file({"path":"package.json"}) = { "name": "toolcall-gateway", ...
    第 2 轮 (2222ms): finish=stop tool_calls=0
    最终答案: 上海当前时间是2026/11/15 09:10:40，而 package.json 描述的是一个名为 toolcall-gateway（版本1.0.0）的私有项目…
    E2E LIVE: PASS model=deepseek-web-flash 工具调用=2 轮次=2 总耗时=5204ms liveCalls=2/40
    ```
  - 结论：模型在同一轮里**并行**发起了 2 个工具调用，回传两条 `role:tool` 后收敛为终答；网关双轮链路成立。

### M8（第二轮新增）

- [x] G8 自动：`node --test test/robustness*.test.mjs` + `node scripts/conformance.mjs`（dry）
  - `npm test`：**51/51 通过**（scaffold 4 + prompt 10 + protocol 12 + streaming 6 + robustness 7 + robustness-protocol 12）
  - 新增 `test/robustness-protocol.test.mjs`（12 组全绿）：reasoning 隔离（思考里的假工具不解析）/ 流式三通道互不污染 / 原生 `tool_calls` 非流式与流式兜底 / 特殊字符参数（中文·emoji·引号·反斜杠·2500 字超长·深层嵌套）/ `max_tokens` 三种别名归一化 / 异常 SSE 框架 / `MODEL_MAP` 与回落 / `MODEL_OVERRIDE` / `GATEWAY_API_KEY` 401 / 客户端 key 被覆盖 / 未知字段剥离 + usage chunk
  - `node scripts/conformance.mjs`（dry，mock）：**35/35 PASS，0 FAIL，0 真实调用**
    ```
    PASS A1..A15（非流式 15 项）  PASS B1..B5（流式 5 项）
    PASS D1..D5（错误 5 项）      PASS E1..E4（兼容 4 项）
    PASS F1..F3（鉴权 3 项）      PASS C1..C3（多轮 3 项）
    CONFORMANCE DRY: total=35 PASS=35 FAIL=0 WARN=0 SKIP=0 liveCalls=0/40
    ```
  - `GATE M8 PASS`
- 备注 / 失败原因 / 修复记录：
  - mock 的 `stream_reasoning` / `stream_native` 在 `buildReply` 里漏了 case（被 default 当纯文本），补齐后通过。
  - 测试 12 最初用 `requestJson` 做流式断言（`res.events` 未定义），改为 `requestSse`。
  - `max_tokens` 归一化只在模拟模式生效；透传模式保持 body 原样（否则破坏 G1 逐字节对比），已写入 README 5.6。

### M9（真实端点）

- [x] G9-a `node scripts/conformance.mjs --live`（2026-11-15 09:16 +08）
  - `total=35 PASS=17 FAIL=0 WARN=10 SKIP=8 liveCalls=25/40`（SKIP 是 live 无法确定性复现的 mock-only 用例）
  - 硬断言通过项：A1/A2/A4/A7/A9、B5、D1（上游 404 原样透传）、D3（504 `upstream_timeout`）、D4（400）、D5（413）、E2（usage）、E3（未知字段忽略）、E4（`gpt-5-codex` → `deepseek-web-flash`）、F1/F2（鉴权）、C1/C2（多轮收敛）
- [x] G9-b `node scripts/e2e_live.mjs --live`：PASS（见 M7）
- [x] G9-c `node scripts/hitrate.mjs --live --runs 8`（09:16 +08）
  ```
  PASS simple: 8/8 = 100.0% (阈值 90%) P50=1907ms P95=3267ms
  PASS complex: 8/8 = 100.0% (阈值 70%) P50=2069ms P95=2375ms
  HITRATE PASS · liveCalls=16/40
  ```
- [ ] G9 复跑：**BLOCKED（不是 FAIL）**
  - 09:24 起上游返回 `403 {"error":{"message":"DeepSeek 网页要求重新登录或人机验证","type":"invalid_request_error"}}`
  - 复跑 `conformance --live` → 首个用例 `SKIP … HTTP 403`，脚本提前终止（`liveCalls=1/40`），`FAIL=0`，不再烧额度
  - 判定：**上游账号状态**（web 会话需人工重新验证），非网关缺陷；网关按规范原样透传 403
  - 恢复：账号所有者完成供应商控制台的重新登录/人机验证后，重跑三条 live 命令即可
- 备注 / 失败原因 / 修复记录：
  - **高频调用会降级**：连续快速请求约 5~10 次后，模型退化为"直接回答、不调工具"（同一 prompt 单独复测可命中）。对策：`LIVE_DELAY_MS` 节流（conformance 1.5s / hitrate 2s），之后 hitrate 100%。
  - **多轮用例无工具不得算 PASS**：改为 live WARN、dry FAIL。
  - **额度统计漏计**：普通用例最初未 `budget.spend()`（报告只显示 5 次）；已改为每次真实请求都计入。
  - **脱敏崩溃**：`maskSecret(undefined)` 抛 `Cannot read properties of undefined (reading 'split')`，已加空值保护并给 `requestSse` 补 `text` 别名。
  - **上游 4xx 误判为网关故障**：`e2e_codex` 的 403 原记为 FAIL，现归类 `BLOCKED_BY_UPSTREAM`（退出码 3），gate 记 SKIP。

### M10（Codex 形状）

- [x] G10 dry：`node scripts/e2e_codex.mjs` → `E2E CODEX: PASS`（gate M10 恒跑这一项）
- [x] G10 live：`node scripts/e2e_codex.mjs --live`（2026-11-15 09:22 +08）
  ```
  正向用例 (1958ms): finish=tool_calls tool_calls=1 usageChunk=true
    - shell({"command":"ls -la"})
    PASS: 客户端可消费的流式 tool_calls（shell 参数含 command）
  反向用例 (1183ms): KNOWN_UNSUPPORTED — 模型改为自然语言回答（可接受的降级）
  E2E CODEX: PASS · live model=gpt-5-codex · liveCalls=2/40
  ```
  - 请求形状：`model=gpt-5-codex`（`MODEL_MAP` → `deepseek-web-flash`）+ `stream:true` + `stream_options.include_usage:true` + `tools=[shell{command,workdir,timeout}]` + 2KB 级 Codex 风格 system
  - README 已补 `config.toml` 样例、支持/不支持矩阵（4.6 / 6.1）
- 备注：`apply_patch` 自由文本工具被模型降级为自然语言/空正文，网关协议层未崩，脚本记 `KNOWN_UNSUPPORTED`。

### M11（应用内设置，2026-11-15）

- [x] G11 自动：`node --test test/settings.test.mjs test/admin.test.mjs`
  - 存储单测 8 项：无文件时用 env / 密钥只回显 hint / update 覆盖 env 且 0600 原子落盘 / 空值取消覆盖 / `modelMap` 两种写法 / 非法输入不写盘 / 坏 JSON 容错 / 白名单校验
  - e2e 9 项（真起两个 mock 上游 + 一个网关）：`/admin` 页面无外链资源 / 设置脱敏 / **PUT 改上游后下一个请求立刻打到新上游** / 非法配置 400 且不改生效值 / 未知字段 400 / `/admin/api/test` 候选配置测连通 / reset 回落 env / 设置文件只含覆盖项 / `ADMIN_TOKEN` 401→200
  - `npm test`：**68/68**；`npm run gate`：`PASS (10/11 通过, 1 跳过)`，`GATE M11 PASS`
- 设计要点：
  - 优先级 **设置文件（UI） > 环境变量 > 默认值**；每个字段带来源标记，避免"到底谁生效"。
  - 热生效：`createServer` 每请求取一次 `settings.get()`，改完立即对后续请求生效，不重启进程。
  - 密钥只在保存时单向上行；任何响应/日志都只给 `sk-***abcd`。
  - 设置页默认只允许回环；远程需 `ADMIN_TOKEN`（Bearer），并带 CSP/`x-frame-options` 头。
  - 持久化到 `DATA_DIR/settings.json`（0600，tmp+rename 原子写）；Docker 侧加 `tcg-data:/app/data` 卷。
- **Docker 实测发现并修复的问题**：容器端口映射（`-p 8787:8787`）下请求来源 IP 是网桥网关（如 `172.17.0.1`），"仅回环"策略会把 `/admin` 挡成 `401`。
  - 修复：新增 `ADMIN_TOKEN` 登录流——`/admin` 未授权时返回登录页，`POST /admin/api/login` 换 `HttpOnly` Cookie（24h），另支持 `Authorization: Bearer`；`deploy.sh` 在 `.env` 里自动生成令牌并打印。
  - 验证：CI 冒烟新增"无令牌必须 401 / 带令牌返回设置页与设置 API"，`sh -n deploy.sh` + `bash -n deploy.sh` 语法检查一并进 CI。

## 5. 未验证项汇总

| 项 | 状态 | 原因 | 复现命令 |
| --- | --- | --- | --- |
| G0-docker（`docker build`） | ✅ 已验证（CI） | 本机无 docker，但 GitHub Actions 真实构建成功 | `gh run view 43675461000 --log` / 见 §9 |
| G6-docker（`docker compose up`） | ✅ 已验证（等价） | CI 冒烟用 `docker run` 起容器 + `/healthz` + `USER node`；compose 文件与本机无 docker 无法直跑 | `docker compose -f docker-compose.prod.yml up -d`（有 docker 的机器） |
| G7 真实上游双轮循环 | ✅ 已验证（09:10） | — | `node scripts/e2e_live.mjs --live` |
| G9 复跑（conformance/hitrate live） | ⚠️ BLOCKED（09:24 起） | 上游 `403 需要重新登录或人机验证`（账号侧状态） | 完成供应商侧验证后重跑三条 live 命令 |
| OpenAI Python/Node SDK 实机调用 | ⛔ 未验证 | 零依赖约束，本机未装 SDK | 见 README 4.3 / 4.4 |
| Codex 真机（CLI 二进制） | ⚠️ 形状已验证，实机未跑 | 本机未安装 Codex CLI；只按其请求形状做了等价 HTTP 复现 | `codex --config ~/.codex/config.toml`（见 README 4.6） |

## 6. 额外自检（非 gate，但真跑过）

1. **密钥不落日志**：以 `LOG_LEVEL=debug` + `UPSTREAM_API_KEY=sk-UNIQUE-SECRET-abc123` 起 mock + 网关，发一次带工具的真实请求；`Select-String -Pattern sk-UNIQUE-SECRET` 扫网关与 mock 日志 → `NO SECRET IN LOGS (gateway+mock)`。日志里 `authorization` 一律显示 `[REDACTED]`（由 `test/scaffold.test.mjs` 的「日志不会打印 API key」用例长期守护）。
2. **上游不可达时的错误映射**：误配自环（网关把上游指到自己）时，客户端收到 `{"error":{"type":"upstream_timeout","message":"上游响应超时"}}`（HTTP 504），未出现未捕获异常。
3. **`npm test` 全量**：`ℹ tests 39  ℹ pass 39  ℹ fail 0`（scaffold 4 + prompt 10 + protocol 12 + streaming 6 + robustness 7）。

## 7. 验收结论

`npm run gate`（= `node scripts/gate.mjs`）在 2026-11-14 22:55 +08 完整跑通，退出码 **0**，7/7 gate 全绿。以下为完整输出：

```
========== M0 ==========

$ node --check src\config.mjs
  --check config.mjs ok (92ms)

$ node --check src\logger.mjs
  --check logger.mjs ok (77ms)

$ node --check src\prompt.mjs
  --check prompt.mjs ok (77ms)

$ node --check src\protocol.mjs
  --check protocol.mjs ok (75ms)

$ node --check src\server.mjs
  --check server.mjs ok (79ms)

$ node --check src\sse.mjs
  --check sse.mjs ok (75ms)

$ node --check src\upstream.mjs
  --check upstream.mjs ok (77ms)
  GET /healthz -> 200 {"status":"ok"}

$ node --test test/scaffold.test.mjs
✔ M0: 脚手架可加载，配置有默认值 (2.317054ms)
✔ M0: 环境变量覆盖生效 (0.399492ms)
✔ M0: 日志不会打印 API key (1.898007ms)
✔ M0: SSE 编码与解析往返 (1.189537ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 139.404868
  scaffold test ok (234ms)
PASS  M0  脚手架与基线（node --check + /healthz + npm test）  (4 项全通过)
GATE M0 PASS

========== M1 ==========

$ node scripts/e2e_passthrough.mjs
  PASS  ① 非流式响应体逐字节一致
  PASS  ② 流式 chunk 序列与直连 mock 一致
  PASS  ③ 上游 429 原样透传状态码与 body
  PASS  ④ /v1/models 透传一致
GATE M1 PASS: 4/4 项通过
  e2e_passthrough ok (746ms)
PASS  M1  透传基线（无 tools）  (4 项断言通过)
GATE M1 PASS

========== M2 ==========

$ node --test test/prompt.test.mjs
✔ 1. 单工具注入：system 逐字包含完整模板与工具 JSON (2.809575ms)
✔ 2. assistant.tool_calls → assistant 文本里的 <tool_call> 块 (0.512914ms)
✔ 3. tool 消息 → user 里的 <tool_result tool_call_id=... name=...> (0.342781ms)
✔ 4. 连续多个 tool 消息合并为一条 user (0.50593ms)
✔ 5. 多段 system（含 developer）合并为一条 system，且排在模板之前 (0.321829ms)
✔ 6. tool_choice = required / {name:X} / none 追加对应句子，auto 不追加 (0.560965ms)
✔ 7. 上游 body 中不含 tools / tool_choice / functions / function_call / parallel_tool_calls / response_format (0.36513ms)
✔ 8. model / temperature / max_tokens 等字段透传，stream 保持 (0.320711ms)
✔ 9. 无 tools 请求：simulated=false，body 原样透传 (0.816026ms)
✔ 10. 历史归一化边界：arguments 非法 JSON 原样嵌入、缺 name 时留空、空 tool_calls 不产生块 (0.505372ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 160.929951
  prompt test ok (248ms)
PASS  M2  请求改写 + 提示注入  (10 组用例通过)
GATE M2 PASS

========== M3 ==========

$ node --test test/protocol.test.mjs
✔ 1. 纯文本 → 无 tool_calls，finish=stop (3.063238ms)
✔ 2. 单个工具调用块 → content=null，arguments 是字符串，finish=tool_calls (1.694908ms)
✔ 3. 两个并列块 → 2 个调用，顺序正确 (0.613485ms)
✔ 4. 前后带文本 → content 为 trim 后的剩余文本 (0.35647ms)
✔ 5. 块内 json 代码围栏 → 正常解析 (0.383848ms)
✔ 6. 尾逗号 → 修复后解析成功 (0.391111ms)
✔ 7. 坏 JSON → 无有效调用，原文保留在 content，不崩溃 (0.814349ms)
✔ 8. arguments 缺失 → "{}" (0.272939ms)
✔ 9. 中文 / 嵌套对象参数原样保留 (2.45087ms)
✔ 10. 空块 → 忽略，不产生调用 (0.567949ms)
✔ 11. 流式 chunk 合成：tool_calls 首包带 id/type/name，arguments 分片可拼回 (1.071086ms)
✔ 12. 流式 chunk 合成：纯文本分片拼回原文，finish=stop (0.455365ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 165.743132
  protocol test ok (259ms)
PASS  M3  响应解析 + 非流式合成  (12 组用例通过)
GATE M3 PASS

========== M4 ==========

$ node --test test/streaming.test.mjs
✔ SSE 解析：事件跨 chunk 边界、CRLF 与注释行 (6.567874ms)
✔ collectStreamText：拼接 content、取 usage 与 model、忽略坏行 (2.210058ms)
✔ buildSseChunks：多工具 index 递增，各自 arguments 可独立拼回 (1.383696ms)
✔ buildSseChunks：emoji/CJK 参数按码点切分，拼回完全一致 (0.846476ms)
✔ buildSseChunks：includeUsage 控制是否补 choices:[] 的 usage 包 (0.50593ms)
✔ encodeSse：输出严格的 data: 行，[DONE] 同样是 data: 行 (0.324623ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 166.20632
  streaming test ok (261ms)

$ node scripts/e2e_stream_tool.mjs
  PASS  ① stream_tool：role 首包 + 工具首包(id/type/name) + arguments 拼接 + finish + [DONE]
  PASS  ② 纯文本流：delta.content 拼回原文，finish_reason=stop
  PASS  ③ malformed 块：流式场景回退为文本 stop，不崩溃
GATE M4 PASS: 3/3 项通过
  e2e_stream_tool ok (744ms)
PASS  M4  流式合成  (单测 + e2e 均通过)
GATE M4 PASS

========== M5 ==========

$ node --test test/robustness.test.mjs
✔ 1. tool_choice=required 首次未给工具 → 重试一次，最终返回 tool_calls (61.179564ms)
✔ 2. 两次都没有工具 → 按文本返回 finish=stop，不报错 (14.324167ms)
✔ 3. 上游超时 → 504 upstream_timeout（OpenAI 风格错误体） (718.643291ms)
✔ 4. 上游 500 → 状态码与 body 原样透传 (8.144331ms)
✔ 5. 缺 messages → 400 (4.285181ms)
✔ 6. body 超 MAX_BODY_BYTES → 413 (6.049931ms)
✔ 7. 非法 JSON → 400 (3.517765ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2494.826577
  robustness test ok (2619ms)
PASS  M5  健壮性与策略  (7 组用例通过)
GATE M5 PASS

========== M6 ==========

$ node scripts/e2e_mock.mjs
  第 1 轮: finish=tool_calls tool=get_time args={"timezone":"Asia/Shanghai"} id=call_f8a93c80e9b1e253c6b0a501
  本地执行工具 get_time → {"timezone":"Asia/Shanghai","now":"2026/11/14 22:55:23"}
  第 2 轮: finish=stop content=现在是 2026-11-14 22:50（Asia/Shanghai，模拟时间）。
  第 2 轮 usage={"prompt_tokens":7,"completion_tokens":11,"total_tokens":18}
E2E MOCK: PASS
  e2e_mock ok (653ms)
PASS  M6  端到端两轮工具循环（不依赖 docker）  (两轮循环通过)
GATE M6 PASS

================ GATE SUMMARY ================
PASS  M0  脚手架与基线（node --check + /healthz + npm test）
PASS  M1  透传基线（无 tools）
PASS  M2  请求改写 + 提示注入
PASS  M3  响应解析 + 非流式合成
PASS  M4  流式合成
PASS  M5  健壮性与策略
PASS  M6  端到端两轮工具循环（不依赖 docker）

GATE RESULT: PASS (7/7)
ALL GATES PASS
```

**结论**：M0~M6 的自动 gate 全部真实执行并通过（每轮都自起 mock 上游 + 网关、真打 HTTP、断言结果），`npm test` 39/39 通过。G0-docker、G6-docker、G7 三项受环境限制（无 docker、无真实上游密钥）**未验证**，已在第 5 节给出原因与可直接复制的复现命令；在具备 docker 与真实密钥的环境中，按第 5 节命令补跑即可闭环。

---

## 8. 第二轮验收报告（M8~M10，真实端点 + Codex）

> 证据标签：`[mock]` = mock 确定性覆盖；`[live]` = 真实端点 `deepseek-web-flash` 实测；`[未验证]` = 无环境/被阻塞。
> 真实端点：`https://agent2api.china-ai.top/v1`，模型 `deepseek-web-flash`（`supports_tool_call:false`、`supports_reasoning:true`）。

### ① 全量矩阵通过率

| 组 | 用例数 | dry（mock，严格） | live（09:16 实测） |
| --- | --- | --- | --- |
| A 非流式 | 15 | 15 PASS | 5 PASS · 4 WARN · 6 SKIP（mock-only） |
| B 流式 | 5 | 5 PASS | 1 PASS · 4 WARN |
| C 多轮 | 3 | 3 PASS | 2 PASS · 1 WARN |
| D 错误 | 5 | 5 PASS | 4 PASS · 1 SKIP（5xx 无法在真实端点强制） |
| E 兼容 | 4 | 4 PASS | 3 PASS · 1 WARN |
| F 鉴权 | 3 | 3 PASS | 2 PASS · 1 SKIP（key 覆盖需 diag） |
| **合计** | **35** | **35 PASS / 0 FAIL / 0 WARN** | **17 PASS / 0 FAIL / 10 WARN / 8 SKIP** |

live 的 SKIP 全部是「只能在 mock 侧确定性构造」的用例（围栏 JSON、大小写变体、特殊字符工具名、原生 tool_calls、5xx 强制、key diag），不是失败。报告文件：`out/conformance-dry.{json,md}`、`out/conformance-live.{json,md}`。
> 注意：`out/conformance-live.*` 当前是**被 403 中断的那次运行**（全 SKIP）；09:16 那次全绿（17 PASS / 10 WARN / 0 FAIL）的逐项结果已完整记录在上表与本文件 M9 章节，带时间戳的副本机制已加入（`conformance-live-<stamp>.json`），后续运行不会再互相覆盖。

### ② 提示词模拟命中率 `[live]`

| 档位 | 次数 | 命中 | 命中率 | 阈值 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 简单工具（单参 `get_weather.city`） | 8 | 8 | **100.0%** | ≥90% | PASS |
| 复杂工具（嵌套 `customer`/`items[]` + 枚举 `priority`） | 8 | 8 | **100.0%** | ≥70% | PASS |

报告：`out/hitrate-live.{json,md}`。样本量 8/档（受额度纪律限制），结论对「此模型 + 此节流节奏」成立。

### ③ 延迟（真实端点，含注入 prompt + buffer-then-synthesize + 网关开销）

| 场景 | P50 | P95 | 备注 |
| --- | --- | --- | --- |
| 简单工具（非流式） | 1907 ms | 3267 ms | hitrate 8 次 |
| 复杂工具（非流式） | 2069 ms | 2375 ms | hitrate 8 次 |
| 双轮循环单轮 | 2955 ms / 2222 ms | — | e2e_live 第 1 / 第 2 轮 |
| Codex 形状流式（工具调用） | 1958 ms | — | e2e_codex 正向 |

### ④ 真实失败样例与采取的修复

| 现象 | 归类 | 证据 | 处理 |
| --- | --- | --- | --- |
| 连续快速请求 5~10 次后，模型开始"直接回答、不调工具" | 上游降级（非网关） | 矩阵中段 A5/A6/A8/B2/B3/C1-C3 转 WARN；同 prompt 单独复测又命中 | live 脚本加 `LIVE_DELAY_MS` 节流（1.5s/2s）；hitrate 恢复 100% |
| `403 {"message":"DeepSeek 网页要求重新登录或人机验证"}` | 上游账号状态（非网关） | 09:24 起所有 live 请求 403；复跑 conformance 首个用例即 SKIP | 网关原样透传 403；脚本改判 `BLOCKED_BY_UPSTREAM`（退出码 3），gate 记 SKIP，不伪造成功 |
| 多轮用例"未调用工具"却记 PASS | 测试口径错误 | 首轮 live 的 C1 显示 `第 1 轮直接给终答` 却是 PASS | 改为 live WARN / dry FAIL |
| 报告 `liveCalls=5` 明显偏低 | 额度统计漏计 | 普通用例未调用 `budget.spend()` | 每次真实请求都计入，逐脚本打印 `used/limit` |
| `maskSecret(undefined)` 崩溃 | 代码缺陷 | 反向用例把 403 误报成 `Cannot read properties of undefined (reading 'split')` | 空值保护 + `requestSse` 补 `text` 别名 |
| 上游 4xx 被当成网关 FAIL | 分类错误 | `e2e_codex` 403 记 FAIL | 4xx → BLOCKED（退出码 3），gate 记 SKIP |

**可解释 WARN 清单（live，10 条，均非网关缺陷）**：
- `A3 正文+工具混合`：模型只输出工具块，`content=null`（符合规范，只是没有块前正文）。
- `A5 tool_choice=auto`：该次模型选择直接回答（auto 允许）。
- `A6 tool_choice=required` / `A8 {name:X}`：发生在上游降级窗口内，重试后仍返回文本；网关按规范返回 `finish_reason:"stop"`，不报错。
- `B1 纯文本流`：模型仍选择调工具，没有正文可流。
- `B2/B3`：降级窗口内的流式未命中 / 并行只给 1 个。
- `B4 include_usage`：上游流里没有 usage 字段，网关按规范省略 usage chunk。
- `E1 reasoning_content`：该 web 模型对测试 prompt 未返回 `reasoning_content`（`supports_reasoning:true` 但未启用），隔离逻辑由 `[mock]` 单测严格覆盖。
- `C3 连续 3 轮`：模型在第 2 轮就给终答（提前收敛），属合理行为。

### ⑤ 与 Codex 类应用的兼容结论 `[live]`

- **支持**：`wire_api="chat"` + `stream:true` + `stream_options.include_usage:true` + JSON-schema `function` 工具（如 `shell{command,workdir,timeout}`）。实测拿到 `id/type/name` 首包 → `arguments` 分片 → `finish_reason:"tool_calls"` → `[DONE]`，并有 usage chunk；`model=gpt-5-codex` 经 `MODEL_MAP` 正确映射到 `deepseek-web-flash`。
- **不支持**：自由文本 / grammar 工具（Codex 的 `apply_patch` freeform 形态）。实测模型降级为自然语言或空正文，网关协议层不崩，脚本记 `KNOWN_UNSUPPORTED`。
- **建议**：改文件场景让 Codex 用 `shell` 工具（heredoc 写文件）完成；或把该工具接到原生工具上游。系统提示会叠加 Codex 的大指令，工具应少而简单。

### ⑥ 结论边界：真实端点已验证 vs 仅 mock / 未验证

| 结论 | 依据 |
| --- | --- |
| 解析/合成/SSE/模型映射/鉴权/reasoning 隔离/原生兜底/特殊字符 → 正确 `[mock]` | 51 单测 + conformance dry 35/35 |
| 该 web 模型在"提示词模拟"下能稳定产出可解析 tool_calls（简单/复杂 100%）`[live]` | hitrate 16 次 + e2e_live 2 次 |
| 双轮/并行双工具/多轮收敛在真实端点成立 `[live]` | e2e_live、conformance C1/C2 |
| Codex 形状（JSON-schema 工具）可消费 `[live]` | e2e_codex live |
| 自由文本/grammar 工具不支持 `[live]` | e2e_codex 反向用例 |
| Docker 镜像可 build / compose 健康 `[未验证]` | 本机无 docker/podman，WSL 无发行版 |
| Python/Node SDK 实机、Codex CLI 实机 `[未验证]` | 无 SDK/CLI，已用等价 HTTP 形状替代 |

### 消耗估算（真实端点）

- 本轮 live 累计请求：**约 96 次**（含探针/排障/矩阵重跑），其中最后约 4 次为 403 拒绝（通常不计费）。
- 每次注入后的 prompt 约 800~1500 tokens（系统模板 + 工具 JSON + 历史），补全约 50~400 tokens。
- 粗估：**约 12 万~15 万 prompt tokens、2 万~4 万 completion tokens**。
- 单脚本上限仍然生效：`MAX_LIVE_CALLS=40`，每次运行都打印 `liveCalls=used/limit`（矩阵 25/40、命中率 16/40、codex 2/40）。
- 供应商 `/v1/models` 返回的 `credits` 字段为空，无法换算成具体金额。

### 本轮离线 gate（M8 / M10）关键输出

```
$ npm run gate
PASS  M8  协议健壮性补齐（robustness* + conformance dry）
SKIP  M9  真实联调（conformance --live / e2e_live / hitrate） — 默认不烧额度，需 --live
PASS  M10  Codex 类客户端请求形状

GATE RESULT: PASS (9/10 通过, 1 跳过)
ALL OFFLINE GATES PASS (M9 live 未跑：加 --live)
```

完整输出见 `out/gate-offline.txt`。M9 的真实结果见上文 ②③⑤（09:16–09:22 的实测），后续因上游 403 转为 BLOCKED。

---

## 9. 发布记录（GitHub + GHCR，2026-11-15）

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/kaoqy/tool-calls-gateway （public，MIT） |
| 首提交 | `41dd14b` — 36 个文件，`.env` 未入库（推送脚本白名单排除） |
| 修复提交 | `0138ac1` — CI 密钥扫描正则收紧（原规则把测试假 key 当泄漏，误报） |
| tag | `v1.0.0` → `0138ac1`（annotated） |
| CI run | `43675461000`（tag）/ `43675460022`（main）—— 全绿 |
| 镜像 | `ghcr.io/kaoqy/tool-calls-gateway:v1.0.0` |
| 其他标签 | `1.0.0` / `1.0` / `latest` / `sha-0138ac1` |
| manifest digest | `sha256:e2fc0822ca4f9325a50a6bdcd31cac3a509ae8bdd4719e60ace1ee7a34c4bd5f` |
| 平台 | `linux/amd64`、`linux/arm64`（另有 provenance/SBOM attestation） |

CI 实际执行的验证（这也是 G0-docker / G6-docker 的闭环证据）：

1. `test` job：Node 20 与 22 矩阵，零依赖校验 → `npm test`（51 项）→ `npm run gate`（M0~M6 + M8 + M10）→ 密钥扫描，全部 success。
2. `docker` job：QEMU + buildx，多架构 build & push 到 GHCR，带 gha 缓存、provenance、SBOM。
3. `smoke` job：本地 build → `docker run` → 轮询 `GET /healthz` 断言 `{"status":"ok"}` → `docker inspect` 断言 `User=node` → 清理容器。

一键部署（发布后可用）：

```bash
# A. 脚本（自动建 .env、拉镜像、起容器、等健康检查）
curl -fsSL https://raw.githubusercontent.com/kaoqy/tool-calls-gateway/main/deploy.sh | sh

# B. compose（预构建镜像）
docker compose -f docker-compose.prod.yml up -d

# C. docker run
docker run -d --name toolcall-gateway -p 8787:8787 \
  -e UPSTREAM_BASE_URL=https://api.deepseek.com -e UPSTREAM_API_KEY=sk-xxx \
  ghcr.io/kaoqy/tool-calls-gateway:v1.0.0
```

> 凭据纪律：`GH_TOKEN` 只写在 `toolcall-gateway/.env`（`.gitignore` + `.dockerignore` 双排除），推送脚本与日志均不打印；仓库 36 个文件经扫描不含真实 key。

### 9.1 版本演进（GHCR）

| 版本 | 提交 | CI | manifest digest | 说明 |
| --- | --- | --- | --- | --- |
| `v1.0.0` | `0138ac1` | `43675461000` ✅ | `sha256:e2fc0822…` | 首次发布：模拟工具调用网关 + 51 单测 + 离线全量 gate |
| `v1.1.0` | `d2e37c5` | `43678360516` ⚠️ smoke 失败 | `sha256:f1b98ae8…` | 应用内设置初版。已知问题：Docker 端口映射下 `/admin` 返回 401（仅回环策略），**用 v1.1.1** |
| `v1.1.1` | `9487663` | `43678695307` ✅ | `sha256:d1a377d6…` | 修复上述问题：`ADMIN_TOKEN` 登录 + HttpOnly Cookie；CI 冒烟覆盖 401/200 与 `deploy.sh` 语法 |

镜像：`ghcr.io/kaoqy/tool-calls-gateway:{v1.1.1,1.1.1,1.1,latest,sha-*}`，平台 `linux/amd64` + `linux/arm64`。
