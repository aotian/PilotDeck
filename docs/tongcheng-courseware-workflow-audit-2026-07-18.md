# 童澄教研资产流程审计（2026-07-18）

## 结论

J01 不是 PilotDeck Cron/Always-On 自主发现后生成的任务。2026-06-22 的 Tiku 自动请求明确指定了课程包、`lesson-01`、J01 标题和固定工作区，并要求生成 `courseware-slides.json` 等课件主资产。

导致“已有课件仍像要整套重做”的直接原因是 PilotDeck 的 `/api/tongcheng/tiku/courseware-slides` 接口：相同课程包和课次会解析到相同工作区；旧实现每次请求都先删除六个主资产/交接文件，再启动 Deck Agent。任务协议没有区分审计、复用、增量修改、新建和重建，因此普通“生成”请求事实上具有重建效果。

本次未启动 PilotDeck/OpenMAIC 服务，未调用线上发布接口，未修改 Teach/Learn 生产数据，也未批量处理 J 系列课件。

## 运行与后台任务检查

- 当前检查时没有 PilotDeck 或 OpenMAIC 进程运行。
- PilotDeck 隔离开发目录 `.pilotdeck-home/.pilotdeck/pilotdeck.yaml` 的 `cron.enabled=false`。
- 用户目录 `/Users/tongcheng/.pilotdeck/pilotdeck.yaml` 的 `cron.enabled=true`，但没有找到 Cron `tasks.json` 或 Always-On project state；即引擎开关打开，但没有已登记后台任务。
- 因此 J01 与后台更新任务无关。它来自 Tiku 的显式服务请求。

## 固定生产规则为什么没有生效

1. `bootstrap-pilotdeck-config.mjs` 原来只复制不存在的 skill 目录，已安装 skill 永远跳过。
2. 仓库版 `tongcheng-courseware-handoff` 已增加 Tiku-first、`courseware-slides.json` 主源、学生端禁词和发布门等规则，但两套运行目录仍是旧版。
3. 2026-06-22 的 J01 会话记录显示，Agent 实际读到的是旧版 protocol v1。
4. “固定生产内容”当时只是仓库规则和生成 prompt，并不是带版本、指纹、写入范围和批准状态的资产锁。

本次已把 `tongcheng-courseware-handoff` 标记为仓库托管的生产协议：启动时只刷新这一项，其他个人 skill 仍保持不覆盖。两套运行目录已同步到当前仓库版本。

## J01 样本审计

- 主源：`courseware-slides.json`。
- 身份：课程包 `bfe804cf-a05e-4b56-bb03-7933184a287e`，课次数据库 ID `0096f000-2f79-4d95-af85-198ba3576d7c`，课次 `lesson-01`。
- 资产：19 页、33 道解析题、3 道真实 Tiku 题、6 个题目引用。
- 共享 validator：0 error、0 warning。
- 资产状态仍为 `reviewing`，不是 approved/published。
- 人工阻断项：新学生续答行为尚需复核；一个 OJ 题的学生提交权限尚未确认。

J01 可以作为流程样本和 validator fixture，不能代表整个 J 系列已经可发布。

## 已落地的安全流程

### 1. 操作模式

- `audit-only`：只检查。
- `reuse-existing`：默认复用已有主资产，不回写生产内容。
- `new-asset`：仅在没有主资产时创建。
- `incremental-update`：必须带老师确认的 `allowedWrites`/patch scope；当前缺失时直接阻断。
- `full-rebuild`：必须显式选择，且先快照到 `.courseware-runs/<runId>/before/`。

旧的 `rebuildMode=generate` 在已有资产时会解析为 `reuse-existing`；只有 `rebuildMode=rebuild` 才映射到 `full-rebuild`。

### 2. 运行契约

每次会写资产的运行生成：

- `asset-request.json`：operationMode、目标课次、允许/禁止写入和发布授权。
- `source-lock.json`：Tiku 身份、输入指纹、生产资产状态和重建快照。
- `agent-run.json`：阶段、角色、阻断和批准状态。
- `reports/<runId>/<role>.json`：保留每个角色的证据，避免单一 `courseware-agent-report.json` 被后续角色覆盖。

### 3. 质量与身份门

修复了 validator 将 `slides` 数组误当成整个 package、从而丢失顶层身份字段的问题。现在会校验：

- `courseware-slides.json` 的 coursePackageId、lessonDbId、lessonId 与 `tiku-context.json` 一致。
- package/handoff 中存在的身份字段也必须一致。
- 内容质量通过后仍停在 `reviewing`；老师批准与 Tiku canonical publish 是单独门禁。

### 4. Teach Agent 边界

Teach Agent 只绑定 Tiku 中 approved/published 的当前版本，只能写指定 lesson/class/topic 的绑定；不得触发 PilotDeck/OpenMAIC 生成、不得修改其他课次、不得反向覆盖 Tiku 主源。固定交接文本见 `skills/tongcheng-courseware-handoff/courseware-production-workflow-v2.md`。

## OpenMAIC 检查

- 当前定制版已默认阻止 `publish-courseware` 与 `publish-to-teach`，要求交回 Tiku job 发布，这是正确边界。
- `asset-standardize` 会优先保留导入 HTML，避免再次调用模型重写视觉稿。
- 仍有一个后续改进：asset loader 主要读取 `deck.html` 与 handoff，尚未把 `courseware-slides.json`、source lock、agent run 作为强制版本对象校验。由于独立发布已关闭，这不是当前生产覆盖风险，但应在下一轮补齐。

## 上游版本

- PilotDeck 当前定制分支相对 upstream/main：ahead 9、behind 581；上游头为 `cbd24cd6`。近期与本流程相关的更新包括 skill resolution、Cron UI、subagent launch/streaming 修复。
- OpenMAIC 当前定制分支相对 upstream/main：ahead 8、behind 235；上游头为 `34448beb`。近期包含 server-backed runtime、RuntimeStore、Agent JSON Patch 等大改。
- 不建议在明日上课前整合上游。两个仓库都存在大量定制与未提交工作；应另建升级分支，按“安全/运行时基础 → 课件相关 → UI”分组 cherry-pick 或 merge，并做完整回归。

## 验证记录

- PilotDeck UI：13 个 test files、72 tests 通过。
- 新运行策略：7 tests 通过。
- Tiku 全部 Node tests：180 tests 通过。
- J01 shared validator strict：PASS，0 errors，0 warnings，身份字段完整。
- 三份 JSON contract template 均通过 JSON 解析。

## 尚未执行

- 未提交、未 push、未部署。
- 未启动服务验证真实 HTTP 往返。
- 未执行 `full-rebuild` 或 `incremental-update`。
- 未修改 J01 主资产与课件内容。
- 未完成 J01 的续答/OJ 人工复核。
