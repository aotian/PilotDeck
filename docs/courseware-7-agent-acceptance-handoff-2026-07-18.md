# PilotDeck 童澄课件 7-Agent 最终验收交接单

日期：2026-07-19
仓库：`/Users/tongcheng/Projects/PilotDeck`

## 1. 当前结论

本轮代码修复和真实 E2E 已完成，可以交给独立 Agent 复验。

真实临时工作区：

```text
/tmp/pilotdeck-final-real-e2e.5dWmsL/real-gateway-7-agent-hq-final
```

真实 runId：

```text
cw-2026-07-18T12-11-44-865Z-350bcea8
```

最终状态：

```json
{
  "status": "awaiting-teacher-approval",
  "currentPhase": "teacher-approval",
  "generationMode": "high-quality",
  "engine": "pilotdeck",
  "degraded": false,
  "teacherApprovedStyleId": "style-b",
  "visualQualityStatus": "pass",
  "completedAgents": [
    "courseware-requirement",
    "courseware-outline",
    "courseware-script",
    "courseware-exercise",
    "courseware-deck",
    "courseware-video",
    "courseware-review"
  ],
  "publishAllowed": false
}
```

这不是生产发布结果。老师审批和 Tiku 正式发布仍然有意保持未执行。

## 2. 本轮修复

### P0-1 并行 Runner 写入隔离

- Script 和 Exercise 仍使用 `Promise.all` 真并行。
- Coordinator 对 `agent-run.json` 的更新记录为 `coordinatorWritesObserved`，不再误判为角色越权写入。
- 兄弟角色产物和 Coordinator 状态写入不会进入当前角色 `filesWritten`。
- 未声明写入仍会被 `Writes outside role contract` 阻断。

### P0-2 full-rebuild 旧资产隔离

- `prepareCoursewareFullRebuild()` 先递归快照并校验 bytes/SHA-256。
- 快照成功后隔离旧 slides、派生资产、风格预览和运行合同。
- high-quality 等待风格确认时，活动目录不再保留旧 `courseware-slides.json`。
- 测试不只检查快照存在，还检查旧主资产确实不在活动目录。

### P0-3 Chrome visual metrics

- 支持 Chrome 的 `<pre id="pilotdeck-quality-metrics" hidden="">` 输出。
- `metrics=null` 是阻断错误，不能返回 pass。
- 只统计真实非空文字节点，不把容器默认 16px 当作页面字号。
- 指标携带 `domPath`、最小字号样本、最低对比度样本、overflow 和 rootOverflow。
- 真实 Chrome 测试验证 metrics 非 null、文字节点计数和真实字号。

### no-op patch

- 老师指定 patch 但目标页没有有效变化时，`validationResult=failed`。
- 不进入视觉检查、导出、Review 或教师审批。
- 目标页以外的修改会被合并保护逻辑丢弃。

### 视觉局部返工

- 先进行确定性修复：非法 CSS 色值、低对比度、投影字号和代码字号。
- 确定性修复不能解决结构问题时，才启动真实 `courseware-deck` repair Agent。
- Repair Agent 只收到目标 slide JSON，第一工具调用必须直接 `edit_file`。
- Agent 结构修订后再次用 Chrome 检查；若 Agent 把字号压低，确定性修复恢复到 18/20px 后复检。
- 最终报告保留同一 runId 的 `revisedSlideIds`，不会被全页复检清空。

### Review 输出合同

- Review 的第一、第二个子 Agent 工具调用必须分别直接写入 `courseware-package.json` 和 `generator-handoff.json`。
- 不能先用 Bash/Python/Node 脚本批量生成这两个文件。
- 两份文件存在后才运行共享 validator。
- 第一次真实 Review 因错误 Bash 参数没有产物，被 Runner 正确阻断；收紧协议后只重试 Review，第二次完成并通过共享 validator。

## 3. 真实 7-Agent 调用链

| 阶段 | 状态 | subagentId | sessionId |
| --- | --- | --- | --- |
| courseware-requirement | ready | `9e528fb0-7fd6-4a16-b147-068d3edf0cf2` | `web:s_52cffcd5-7ff2-49f4-ae93-482825d7e98a` |
| courseware-outline | ready | `1e229229-6824-4e77-8ba9-2dd4f61e70c4` | `web:s_0e811be6-1bfa-4771-a496-c08edb469645` |
| courseware-script | ready | `e5f46546-6afe-4531-9657-432601b5108c` | `web:s_dffb7bea-5219-4a58-a2a8-629c07205568` |
| courseware-exercise | ready | `74fecec7-3194-49e6-8afc-ccb9e95e260d` | `web:s_24e68952-d368-4977-9631-04dcf34b2396` |
| courseware-deck | ready | `2f633edc-c1d8-4e3c-b7c6-cfa97642d1ee` | `web:s_c6b1abe3-787f-4c47-b83a-38ff980522c2` |
| courseware-video | ready | `6f93ae43-c737-4576-832c-000f475163a1` | `web:s_02200ce4-2851-4431-820d-72be57542ed7` |
| courseware-review | ready | `f5dbdc09-5793-4587-a613-8d690f901d0a` | `web:s_d6da7f42-d9f7-48e2-9e9a-77bc76248ecb` |

每份最终报告都记录：

```text
subagentType
subagentId
sessionId
startedAt
completedAt
status
inputsRead
filesWritten
blockers
checks
model=tc-admin/tc-main
agentToolCallCount=1
```

报告位置：

```text
reports/cw-2026-07-18T12-11-44-865Z-350bcea8/courseware-requirement.json
reports/cw-2026-07-18T12-11-44-865Z-350bcea8/courseware-outline.json
reports/cw-2026-07-18T12-11-44-865Z-350bcea8/courseware-script.json
reports/cw-2026-07-18T12-11-44-865Z-350bcea8/courseware-exercise.json
reports/cw-2026-07-18T12-11-44-865Z-350bcea8/courseware-deck.json
reports/cw-2026-07-18T12-11-44-865Z-350bcea8/courseware-video.json
reports/cw-2026-07-18T12-11-44-865Z-350bcea8/courseware-review.json
```

Script/Exercise 在 Outline 后真实重叠执行，上游四个阶段 attempts 均为 1。Deck attempts 包含本轮之前保留的多次视觉调试历史，不应当作一次干净运行的调用数量；每次失败、回滚和 no-op 都保留在 patch history，没有伪装成功。

## 4. high-quality 暂停与恢复

1. Requirement、Outline、Script、Exercise 完成。
2. Deck 生成 `design-brief.json` 和三套结构不同的预览。
3. 状态进入 `awaiting-style-approval`，此时完整 slides 不存在。
4. 老师选择 `style-b`，写入 `approved-style.json`。
5. 使用同一 runId 恢复，上游 ready 阶段不重复执行。
6. Deck 读取 `approved-style.json` 生成 11 页主资产。
7. Chrome 全页检查和目标页返工完成。
8. PilotDeck 从主资产导出 PPTX/PDF。
9. Video、Review、共享 validator 完成。
10. 状态停在 `awaiting-teacher-approval`。

三套预览均包含：

```text
style.json
cover.html
concept.html
example.html
practice.html
preview.png
```

测试会验证 layout family、信息层级、diagram/code/interaction 结构和 design tokens 不完全相同，不只是换颜色。

## 5. 视觉与导出结果

`visual-quality-report.json`：

- 11/11 页面 `metrics` 非 null。
- 11/11 页面 status=pass。
- 所有页面 `overflowing=[]`、`rootOverflow=false`。
- 所有页面 `minFontPx >= 18`。
- 所有页面 `minContrast >= 4.5`。
- `failedSlideIds=[]`。
- 同一 runId 的局部返工页保留在 `revisedSlideIds`。

截图：

```text
screenshots/cw-2026-07-18T12-11-44-865Z-350bcea8/slide-01.png ... slide-11.png
screenshots/cw-2026-07-18T12-11-44-865Z-350bcea8/contact-sheet.png
```

导出：

| 资产 | 结果 |
| --- | --- |
| `courseware.pptx` | 680379 bytes，11 页，`unzip -t` 无错误 |
| `courseware.pdf` | 915327 bytes，11 页，960 x 540 pt |
| `pptx-export.json` | `sourceOfTruth=courseware-slides.json`，`openmaicRendererUsed=false` |
| `pdf-export.json` | `sourceOfTruth=courseware-slides.json`，`openmaicRendererUsed=false` |

PPTX 目前使用 PilotDeck 逐页截图作为全页视觉，忠实保留 HTML 样式，但不是原生可编辑文本/图形对象。

## 6. 关键代码

| 文件 | 作用 |
| --- | --- |
| `ui/server/courseware-agent-orchestrator.js` | 依赖图、并行、blocked 传播、恢复、风格暂停、确定性/Agent 局部返工 |
| `ui/server/courseware-agent-runner.js` | Gateway + Agent Tool + subagent_type、生命周期、写入范围、输出合同 |
| `ui/server/courseware-agent-state.js` | 九阶段状态、原子更新、真实状态摘要 |
| `ui/server/courseware-run-policy.js` | operationMode、full-rebuild 快照/隔离、报告归档 |
| `ui/server/courseware-visual-quality.js` | Chrome metrics、截图、视觉门禁、局部合并、确定性修复 |
| `ui/server/courseware-derived-assets.js` | PilotDeck PPTX/PDF 导出 |
| `ui/server/index.js` | 生成、恢复、状态、风格确认和 patch API |
| `ui/server/pilotdeck-bridge.js` | Gateway 与 subagent 生命周期帧 |
| `src/agent/sub/builtinSubagentTypes.ts` | 7 个正式课件 subagent 类型 |
| `src/agent/loop/AgentLoop.ts` | Agent/subagent 输出预算传递 |
| `ui/src/components/main-content-v2/CoursewareProgramV2.tsx` | 最小阶段、模式、阻断、风格、降级和审批状态 |

`jsdom` 已放入 `ui` 生产 dependencies，因为服务端确定性视觉修复在运行时需要 DOM 解析。

## 7. API 验收点

```text
POST /api/tongcheng/tiku/courseware-slides
GET  /api/tongcheng/tiku/courseware-slides/status
POST /api/tongcheng/tiku/courseware-slides/style-approval
POST /api/tongcheng/tiku/courseware-slides/patch
```

生成/状态返回包含：

```text
runId
coordinatorSessionId
currentPhase
status
completedAgents
runningAgents
blockedAgents
reportPaths
operationMode
generationMode
engine
degraded
degradedReason
styleApprovalRequired
teacherApprovedStyleId
visualQualityStatus
workspacePath
```

显式 template fallback 只允许 `automatic-draft + allowTemplateFallback=true`。high-quality 不会静默 fallback，也不会把模板草稿报告为高质量成功。

## 8. fallback 与 Token Plan

额度恢复后没有触发 fallback 是正常行为：

- 主路由 `tc-admin/tc-main` 已成功，因此 Router 没有理由切换。
- 已经输出文字或工具事件后，Router 不会中途换模型，以免重复执行文件修改。
- 当前 `tc-main`、`tc-economy`、`tc-multimodal` 别名使用同一个 `tc-admin` 网关和 MiniMax Token Plan，不是独立容灾容量。
- 真正的额度 fallback 需要配置第二供应商或第二账户凭据，再加入 `router.fallback.default`。
- high-quality 视觉失败也不会走模板 fallback；它必须保持 blocked 并等待恢复/返工。

因此本次 `fallbackTriggered=false`、`degraded=false`，原因是主模型恢复并成功，而不是 fallback 失效。

## 9. 测试结果

| 命令 | 结果 | 退出码 |
| --- | --- | ---: |
| `pnpm --dir ui exec vitest run server/courseware-agent-orchestrator.test.js server/courseware-agent-runner.test.js server/courseware-visual-quality.test.js server/courseware-derived-assets.test.js server/courseware-run-policy.test.js` | 5 files，57/57 | 0 |
| `pnpm --dir ui test` | 17 files，122/122 | 0 |
| `pnpm run build` | 根 TypeScript 构建通过 | 0 |
| `pnpm --dir ui run build` | Vite 构建通过；仅既有 chunk-size warning | 0 |
| `pnpm test` | 根构建 + 编译后 Agent 输出预算测试 1/1 | 0 |
| `cd /Users/tongcheng/Projects/AI-practice && node --test test/courseware-validator.test.js` | 16/16 | 0 |
| 真实 Gateway + Agent Tool 临时 API 恢复 | 7 角色 ready，HTTP 200 | 0 |
| 最终真实 Chrome 全页复检 | 11/11 metrics 非 null，全部 pass | 0 |
| `unzip -t courseware.pptx` | 无错误 | 0 |
| `pdfinfo courseware.pdf` | 11 页，960 x 540 pt | 0 |
| `git diff --check` | 无输出 | 0 |

Vite 的大 chunk 提示不是构建失败。UI `typecheck` 和 `lint` 不是本轮验收命令，本轮没有重新宣称它们通过。

## 10. 独立验收命令

```bash
cd /Users/tongcheng/Projects/PilotDeck
git status --short
git diff
git diff --check
```

```bash
pnpm --dir ui exec vitest run \
  server/courseware-agent-orchestrator.test.js \
  server/courseware-agent-runner.test.js \
  server/courseware-visual-quality.test.js \
  server/courseware-derived-assets.test.js \
  server/courseware-run-policy.test.js
pnpm --dir ui test
pnpm run build
pnpm --dir ui run build
pnpm test
```

```bash
cd /Users/tongcheng/Projects/AI-practice
node --test test/courseware-validator.test.js
```

```bash
E=/Users/tongcheng/Projects/PilotDeck/docs/acceptance-evidence/courseware-7-agent/cw-2026-07-18T12-11-44-865Z-350bcea8
jq '{status,currentPhase,phases,visualQuality,publish}' "$E/agent-run.json"
jq '{status,revisedSlideIds,slides:[.slides[]|{slideId,status,metrics}]}' "$E/visual-quality-report.json"
find "$E/reports" -name 'courseware-*.json' -print
unzip -t "$E/courseware.pptx"
pdfinfo "$E/courseware.pdf"
```

J01 保护：

```bash
cd /Users/tongcheng/Projects/PilotDeck
git status --short -- workspaces/2026-csp/lessons/lesson-01
find workspaces/2026-csp/lessons/lesson-01 -type f -newermt '2026-07-18 04:00:00'
```

当前两条 J01 检查均无输出。

## 11. 验收证据

完整证据包：

```text
/Users/tongcheng/Projects/PilotDeck/docs/acceptance-evidence/courseware-7-agent/cw-2026-07-18T12-11-44-865Z-350bcea8
```

证据包包含：

- 最终 `agent-run.json`。
- 7 份独立角色报告。
- `design-brief.json`、`approved-style.json` 和三套预览截图。
- 11 页 `courseware-slides.json`。
- 11 张页面截图和联系表。
- `visual-quality-report.json`。
- `courseware-package.json`、`generator-handoff.json`。
- `courseware.pptx`、`courseware.pdf` 和导出 manifest。
- 真实 E2E 摘要和测试结果。

## 12. 安全声明与剩余边界

- 未修改、重新生成或覆盖 J01。
- 未调用生产 Tiku、Teach、Learn、OpenMAIC 发布或绑定接口。
- 未绑定生产课程、班级、学生、考试或知识点。
- 未自动发布，`publish.allowed=false`。
- 未提交、未 push。
- 当前工作区保留用户原有未提交修改，验收 Agent 不应清理或重置。
- 当前 fallback 配置不是独立供应商容量，这是部署配置风险，不是本次流程伪装成功。
- 教师审批有意保持 pending，验收 Agent 不应将其改成已发布。
