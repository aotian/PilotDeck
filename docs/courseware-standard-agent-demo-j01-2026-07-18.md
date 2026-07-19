# 标准教研资产 Agent 流程：J01 演示记录

## 演示目标

J01 仅作为已有资产样本，验证 Tiku → PilotDeck → OpenMAIC → Tiku → Teach/Learn 的通用流程。不重新生成 J01，不修改其主课件，不发布或绑定生产数据。

## 标准输入

- Tiku 主源：课程包、课次、知识图谱节点、题库题目、正式考试时长与课堂模式。
- PilotDeck 主资产：`courseware-slides.json`。
- PilotDeck 派生资产：`deck.html`、PPTX、`slides-manifest.json`。
- 运行契约：`asset-request.json`、`source-lock.json`、`agent-run.json`。
- 审核证据：共享 validator、角色报告、人工 blockers。

## J01 预检结果

- 课程包 ID、课次数据库 ID、`lesson-01` 在 Tiku context、slides、manifest、package 和 handoff 中一致。
- 标准资产文件完整。
- 共享质量门存在通过证据。
- 状态为 `reviewing`，不是 approved/published。
- J01 是旧运行资产，缺少同一 runId 的 `source-lock.json`/`agent-run.json`。
- 新学生续答行为与 OJ 学生提交权限仍为人工复核项。

因此：

- `canStandardize=true`：可用于 OpenMAIC 兼容预览和人工标准化演示。
- `canAutoStandardize=false`：不得作为无人值守自动入库任务。
- `canPublish=false`：不得进入 Teach/Learn 发布。
- `nextAction=upgrade-runtime-contract`：仅表示未来新任务应按 v2.1 契约运行，不要求重建 J01。

## 可重复命令

```bash
cd /Users/tongcheng/Projects/OpenMAIC
pnpm courseware:preflight -- --workspace /Users/tongcheng/Projects/PilotDeck/workspaces/2026-csp/lessons/lesson-01
```

未来新资产在自动交接前使用严格模式：

```bash
pnpm courseware:preflight -- --workspace <lesson-workspace> --strict
```

严格模式只有在资产完整、身份一致、source lock/agent run 同 runId 且质量证据通过时才返回成功。

## Agent 接力规则

1. Tiku Coordinator 生成 `tiku.courseContext.v1`，只从知识图谱和题库选择真实来源。
2. PilotDeck Coordinator 明确 operationMode，写请求、来源锁和 run。
3. PilotDeck 各角色只写授权文件；Deck 维护 slides 主源，PPT/HTML 仅派生。
4. PilotDeck Review 运行共享 validator，停在 `teacher-approval`。
5. OpenMAIC 输出 `tongcheng.coursewareIngestPreflight.v1`，标准化候选资产但不发布。
6. OpenMAIC 候选结果返回 Tiku，由老师审核具体版本。
7. Tiku canonical publish 后，Teach Agent 只做指定 lesson/class/topic 绑定。
8. Learn 只呈现已发布版本；正式试卷时长与课堂不限时模式分别保存。
