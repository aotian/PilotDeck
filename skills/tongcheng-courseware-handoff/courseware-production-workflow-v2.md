# 童澄教研资产标准流程 v2.1

本流程用于 Tiku、PilotDeck、OpenMAIC、Teach、Learn 之间的课件生产。目标是产出可追溯的教研资产包，而不是让任一 Agent 直接修改线上课件。

## 一、系统职责

- **Tiku**：课程包、课次、知识点、正式题目与发布状态的唯一业务主源；创建任务、保存候选稿、组织审核、执行正式发布。
- **PilotDeck**：在单课次工作区内完成教研创作、派生文件生成、质量检查和运行留痕；不得直接发布到 Teach/Learn。
- **OpenMAIC**：导入、预览、标准化和交互化候选资产；不得把 `deck.html` 反向覆盖 `courseware-slides.json`，不得独立发布。
- **Teach Agent**：只消费 Tiku 已批准版本，完成班级、课次、主题和资源绑定；不得触发整套课件生成或修改其他课次。
- **Learn**：呈现学生可见课件、练习和作答入口，不承担教研资产生产。

标准链路只有一条：

```text
Tiku 组装知识图谱/题库上下文
  -> PilotDeck 生成或修订标准课件与 PPT 派生资产
  -> OpenMAIC 校验身份、版本和运行契约并完成资源标准化
  -> 标准化候选稿返回 Tiku
  -> 老师审核批准
  -> Tiku canonical publish
  -> Teach 绑定
  -> Learn 展示
```

Tiku 内部的轻量 AI 课件生成只能作为 PilotDeck 不可用时的显式 fallback，产物仍必须进入同一质量门和审核状态，不能与 PilotDeck 同时生成两套主资产。

## 二、每次任务必须先声明动作

| operationMode | 用途 | 默认写权限 |
| --- | --- | --- |
| `audit-only` | 检查已有资产、链接、题目和发布条件 | 只读；可另写独立审计报告 |
| `reuse-existing` | 复用当前主资产并重新校验 | 不改主资产 |
| `new-asset` | 当前课次没有主资产时创建第一版 | 只写本课工作区 |
| `incremental-update` | 按老师确认的范围局部修改 | 必须提供 `allowedWrites` 和 patch scope |
| `full-rebuild` | 明确废弃当前候选稿并重建 | 必须人工选择，先生成完整快照 |

如果请求只写“生成”，但工作区已有 `courseware-slides.json`，一律解释为 `reuse-existing`。不得自动升级为 `full-rebuild`。

## 三、标准状态机

```text
requested
  -> source-locked
  -> producing
  -> quality-review
  -> teacher-review
  -> approved
  -> tiku-publishing
  -> published

任一阶段失败 -> blocked
```

- `quality-review` 只说明结构、内容安全、题目与链接检查通过。
- `approved` 必须由老师确认，Agent 不得自行设置。
- `published` 只能由 Tiku canonical publish 写入。
- 有任何人工复核项时，状态最高只能到 `teacher-review`。

## 四、运行契约

每次会修改资产的任务必须先写：

1. `asset-request.json`：目标课次、operationMode、允许写入文件、禁止写入范围和发布授权。
2. `source-lock.json`：Tiku 身份、输入摘要、现有生产资产状态、输入与原资产指纹。
3. `agent-run.json`：runId、阶段、角色、结果、阻断项和批准状态。

`full-rebuild` 还必须写入 `.courseware-runs/<runId>/before/` 快照。没有快照不得删除或覆盖已有主资产。

## 五、标准教研资产包

主资产：

- `courseware-slides.json`：唯一可编辑课件主源。
- `brief.md`、`course-outline.md`、`teacher-script.md`。
- `exercises.md`、`homework.md`、`pitfalls.md`。
- `tiku-context.json`：真实 Tiku 身份、知识点和题目上下文。

派生资产：

- `deck.html`、PPTX、PDF、`slides-manifest.json`。
- 派生资产可重新生成，但不能反向成为主源。

交接与审计：

- `courseware-package.json`、`generator-handoff.json`。
- `courseware-agent-report.json`：兼容性最新报告。
- `reports/<runId>/<role>.json`：各角色不可覆盖的运行报告。
- `asset-request.json`、`source-lock.json`、`agent-run.json`。

## 六、Agent 分工

1. **Coordinator**：解析 operationMode，锁定课次身份和写入范围；已有资产时默认复用。
2. **Requirement**：只更新 brief 与需求差异；不得生成课件。
3. **Outline**：只更新课程结构与易错点。
4. **Teaching Script**：只更新老师讲稿，不写学生 HTML。
5. **Exercise**：Tiku-first，保留 question_id/knowledge_id；AI 题只能是 draft。
6. **Deck**：写 `courseware-slides.json`；HTML/PPT/PDF 仅作为派生输出。
7. **Video**：只从已批准结构生成脚本。
8. **Review/Package**：只校验和打包，不擅自修订教学内容，不发布。

每个角色只写自己的文件。兼容报告可更新，但还要把本角色报告保存到 `reports/<runId>/<role>.json`，避免前一角色的证据被覆盖。

## 七、质量门与发布门分离

质量门至少检查：

- 资产完整、JSON schema、每页 HTML、数学公式与视觉布局。
- 学生可见文本、危险脚本/链接、Learn `_top` 跳转。
- Tiku 正式题身份、答案解析、知识点、OJ 可用性。

发布门还必须检查：

- `agent-run.json.status == approved`。
- `courseware-agent-report.json.blockers` 为空。
- 老师批准人、批准时间和批准版本存在。
- source lock 与待发布资产指纹一致。
- Teach/Learn 绑定目标明确且属于同一课次。

结构校验 0 错误并不等于可以发布。

## 八、OpenMAIC 入库前置检查

OpenMAIC 读取的对象必须包含：

- 主源 `courseware-slides.json`、`tiku-context.json` 和 `slides-manifest.json`。
- `courseware-package.json`、`generator-handoff.json`。
- 同一 `runId` 的 `source-lock.json` 与 `agent-run.json`。
- 共享质量门报告和仍待人工复核的 blockers。

OpenMAIC 必须输出 `tongcheng.coursewareIngestPreflight.v1`，分别报告：资产完整性、课次身份一致性、运行契约、质量门、教师批准和 Tiku 发布状态。

- `canStandardize=true` 只表示资产可做兼容预览或标准化候选稿。
- `canAutoStandardize=true` 才表示来源锁、runId 和质量证据完整。
- `canPublish=true` 仍不授权 OpenMAIC 发布；它只表示可把“建议发布”的候选结果交回 Tiku。
- OpenMAIC 不得把生成后的 HTML/PPT 反向改写为 `courseware-slides.json`。

## 九、后台任务规则

后台 Cron/Always-On 只能使用 `audit-only`：

- 可以检查上游更新、技能版本漂移、资产缺失、失效链接和待复核项。
- 可以生成独立审计报告和候选任务。
- 不得删除、覆盖、发布课件；不得触发 `full-rebuild`。
- 发现问题后由老师或教研负责人创建 `incremental-update` / `full-rebuild` 任务。

## 十、交给 Teach Agent 的固定说明

```text
本任务是绑定已批准教研资产，不是生成或重建课件。
只读取 Tiku 中当前 approved/published 的 courseware_slides 版本。
只允许修改指定 lessonId/classId/topicId 的绑定记录。
不得调用 PilotDeck/OpenMAIC 生成接口，不得改其他课次，不得反向覆盖 Tiku 主资产。
若资产状态不是 approved/published、存在 blockers、source lock 不一致或目标 ID 不完整，立即 blocked 并报告，不做猜测。
课堂整卷采用不限时练习模式；正式考试时长仍保留在试卷元数据中，不把 120 分钟强制到课堂模式。
```

## 十一、J01 的定位

J01 只作为流程样本和校验夹具，不再作为单独生产需求。它当前可以用于验证资产结构、OpenMAIC 兼容预览、Learn 不限时入口和 Teach 交接协议。

J01 属于旧运行生成的资产，因此缺少同一 `runId` 的 `source-lock.json`/`agent-run.json` 时，应显示为“可兼容预览、不可自动标准化”；不得为了补齐合同而重建 J01。续答行为与 OJ 学生权限复核完成前，也不得据此把整个 J 系列标记为可发布或批量重建其他课次。
