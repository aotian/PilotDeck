# Tongcheng Courseware Agent Protocol v1

This protocol keeps long courseware production out of a single model context.
Each agent receives a small input packet, writes a bounded set of files, and
returns a machine-readable handoff report. The next agent reads only the
required upstream files and reports, never the full chat transcript.

## Shared Rules

- Production must start from a Tiku course package when the final asset is meant for Tiku/Teach/Learn. Local files are workspaces, not the source of truth for official knowledge nodes or official questions.
- A program workspace can contain many lesson workspaces. Do not hand off a program workspace when the user asks to publish one lesson; hand off `lessons/lesson-xx` instead.
- Work inside one lesson directory unless the coordinator explicitly assigns a program-level file.
- Read only the files listed in the input packet plus the previous `courseware-agent-report.json` files.
- Do not paste full HTML, PPT source, PDFs, screenshots, or large generated content into chat.
- Produce files first; the final reply is only a short report with paths, status, and blockers.
- If a dependency is missing, write a `blocked` report instead of guessing.
- Long HTML slide work must be chunked: schema shell first, then 1-3 slides per edit.
- Exercises are candidates until Tiku review; never mark them as official homework or exam items without review.
- Student-facing assets such as `courseware-slides.json` `slides[].html`, `deck.html`, `courseware.html`, student previews, and video visuals must not expose teacher operations or internal system wording. Keep words such as `江校`, `agent`, `OpenMAIC`, `Pilot`, `内部`, `验收`, `落库`, `metadata`, `courseware_jobs`, and `老师讲稿` out of student-facing copy unless they are part of the lesson content itself. Put teacher-only reminders in `slides[].notes`, `teacher-script.md`, or review reports.
- If a lesson has `tiku-context.json` or Tiku search results, exercises must use those questions first and preserve `question_id` / `knowledge_id`. AI-generated questions are only gap-fill drafts and must be tagged `ai-draft`.
- If no real Tiku context is available, write the required Tiku inputs and set package status to `blocked` or `draft`; do not invent official Tiku IDs.
- A generated student-facing slide package cannot be marked `ready` until it passes: every slide has `html`, no internal terms, no teacher-only operations in student HTML, no unsafe external scripts, no missing slide order, and no obvious desktop/mobile overflow.

## Coordinator SOP

1. Confirm the selected Tiku course package, lesson, knowledge node, and question scope.
2. Create or update the target workspace under the configured asset workspaces root.
3. Write the Tiku input packet to `tiku-context.json` only when it comes from the real Tiku API or a teacher-approved export.
4. Run agents in order. Each agent reads only its assigned inputs and writes only its assigned outputs.
5. Stop the pipeline when an agent reports `blocked`; do not let later agents guess missing data.
6. Before handoff, Review And Package Agent must refresh `courseware-package.json` and `generator-handoff.json`.
7. The Tongcheng publishing pipeline receives the package for validation and publishing; it should write `courseware-slides.json` into Tiku `metadata.courseware_slides` and treat `deck.html`/PPT/PDF as derived assets.

## Completion Gates

- `requirements-ready`: `brief.md` exists and lists subject, lesson, duration, output targets, Tiku input scope, and blockers.
- `outline-ready`: `course-outline.md` and `pitfalls.md` exist, with timings and learning path.
- `exercise-ready`: `exercises.md` lists real Tiku questions or clearly states missing Tiku coverage.
- `slides-ready`: `courseware-slides.json` exists, uses schema `tiku.coursewareSlides.v1`, every slide has student-visible `html`, and it passes visual/safety checks.
- `video-ready`: `video-script.md` exists and maps to the lesson structure.
- `package-ready`: `courseware-package.json` and `generator-handoff.json` exist and status is `ready` or `draft` with explicit blockers.

## Standard Lesson Files

Every lesson directory may contain:

- `tiku-context.json`
- `brief.md`
- `course-outline.md`
- `teacher-script.md`
- `exercises.md`
- `pitfalls.md`
- `deck-plan.md`
- `style-previews/style-a.html`
- `style-previews/style-b.html`
- `style-previews/style-c.html`
- `courseware-slides.json`
- `deck.html`
- `slides-manifest.json`
- `video-script.md`
- `courseware-package.json`
- `generator-handoff.json`
- `courseware-agent-report.json`

## Agent Roles

### 1. Requirement Agent

Input:

- Teacher request
- Program metadata
- `tiku-context.json` when the task comes from Tiku
- Existing lesson source files

Writes:

- `brief.md`
- `courseware-agent-report.json`

Exit criteria:

- Subject, grade/level, topic, duration, outputs, teaching mode, and acceptance criteria are explicit.

### 2. Outline Agent

Input:

- `brief.md`
- `tiku-context.json`, program knowledge map, or source materials

Writes:

- `course-outline.md`
- `pitfalls.md`
- `courseware-agent-report.json`

Exit criteria:

- Lesson sections, timing, learning path, core examples, and common mistakes are structured.

### 3. Teaching Script Agent

Input:

- `brief.md`
- `course-outline.md`
- `pitfalls.md`

Writes:

- `teacher-script.md`
- `courseware-agent-report.json`

Exit criteria:

- Teacher-facing flow is concise, classroom usable, and avoids student-facing noise.

### 4. Exercise Agent

Input:

- `brief.md`
- `course-outline.md`
- `tiku-context.json`, Tiku search results, or supplied question files

Writes:

- `exercises.md`
- optional `homework.md`, `oj-exercises.md`, `edu-exercises.md`
- `courseware-agent-report.json`

Exit criteria:

- Questions are tagged by source: `tiku`, `ai-draft`, or `manual`.
- Real Tiku questions preserve `question_id`, `knowledge_id`, difficulty, answer, and analysis.
- Missing Tiku coverage is listed explicitly.

### 5. HTML Slides Agent

Input:

- `brief.md`
- `course-outline.md`
- `teacher-script.md`
- chosen style or style request
- `exercises.md`
- `tiku-context.json` when available

Writes:

- `style-previews/style-a.html`, `style-previews/style-b.html`, `style-previews/style-c.html` before final slides if no style is chosen and the task is interactive/free-design
- `deck-plan.md`
- `courseware-slides.json`
- `deck.html` as a derived preview/backup rendered from `courseware-slides.json`
- `slides-manifest.json` as derived navigation/export metadata
- `courseware-agent-report.json`

Exit criteria:

- `courseware-slides.json` is self-contained enough for Tiku to write into `metadata.courseware_slides`; each slide has `id`, `order`, `type`, `title`, `html`, `markdown`, `notes`, `duration_minutes`, and `student_visible`.
- Deck preview is self-contained, visually polished, classroom-presentable, and validated by targeted checks.
- Student-facing `slides[].html` does not contain teacher instructions, internal workflow names, or platform implementation names.
- Any embedded exercise with a Tiku source preserves its `question_id`; AI-only items are visibly treated as drafts in package metadata, not official Tiku items.
- No single tool call writes or edits a large slide package or deck.
- In Tiku automatic generation mode, do not block on three style previews; use the selected subject template and generate `courseware-slides.json` directly.

### 6. Video Agent

Input:

- `brief.md`
- `course-outline.md`
- `teacher-script.md`
- `courseware-slides.json` or `slides-manifest.json` if available

Writes:

- `video-script.md`
- `courseware-agent-report.json`

Exit criteria:

- Tutor-style script includes scene, narration, board/action notes, and optional asset suggestions.

### 7. Review And Package Agent

Input:

- All generated lesson files
- Previous agent reports

Writes:

- `courseware-package.json`
- `generator-handoff.json`
- `courseware-agent-report.json`

Exit criteria:

- Required fields are present.
- `courseware-slides.json` is checked for schema, slide count, required `html`, dangerous links/scripts, and mobile/desktop notes.
- Student-facing slide HTML is checked for teacher/internal wording and blocked if such wording is present.
- Tiku-sourced questions are checked for preserved `question_id`, `knowledge_id`, difficulty, answer, and analysis.
- Publish readiness is `blocked`, `draft`, or `ready` with reasons.

## Handoff Report Schema

Every agent must write `courseware-agent-report.json`:

```json
{
  "schemaVersion": "tongcheng.coursewareAgentReport.v1",
  "agentRole": "deck",
  "lessonId": "lesson-01",
  "status": "ready",
  "inputsRead": ["brief.md", "course-outline.md"],
  "filesWritten": ["courseware-slides.json", "deck.html", "slides-manifest.json"],
  "nextAgent": "review-package",
  "blockers": [],
  "checks": [
    { "name": "slide-count", "status": "pass", "detail": "18 slides" }
  ],
  "updatedAt": "2026-06-15T00:00:00.000Z"
}
```

Status values:

- `ready`: output is ready for the next agent.
- `draft`: usable but needs review or completion.
- `blocked`: missing required input or failed validation.

## Tiku Context Input Schema

When a lesson starts from Tiku, the coordinator should provide `tiku-context.json`.
For local simulation, write this file manually into the lesson workspace. For
production, Tiku should create it from the selected knowledge node and question
scope before launching PilotDeck.

Legacy `pilot-tiku-input.json` is still accepted for old J01-style workspaces.
Before agents run, convert it into `tiku-context.json` and preserve
`coursePackage`, `lesson`, `knowledgeIds`, `eduAssessment`, and `ojProblems`.
Agents should read `tiku-context.json` as the unified input and should not treat
`pilot-tiku-input.json` as the current protocol.

```json
{
  "schemaVersion": "tiku.courseContext.v1",
  "source": "tiku",
  "subject": "cpp",
  "coursePackage": {
    "id": "2026-csp",
    "title": "2026 CSP 12 次课课程包",
    "lessonId": "lesson-06",
    "lessonTitle": "字符串处理与模拟"
  },
  "knowledge": {
    "rootNodeId": 397,
    "nodeId": 397,
    "nodeName": "字符串处理与模拟",
    "path": "编程 / C++ / 2026 CSP / 第 06 课",
    "descendantNodeIds": [397],
    "objectives": [
      "理解字符串遍历与下标访问",
      "能用循环完成模拟处理"
    ]
  },
  "questionPolicy": {
    "source": "tiku-first-ai-fill",
    "preferredKinds": ["class_practice", "homework", "quiz"],
    "maxCandidates": 12,
    "allowAiDraftForGaps": true
  },
  "questions": [
    {
      "question_id": "12345",
      "knowledge_id": 397,
      "kind": "class_practice",
      "type": "oj",
      "difficulty": "easy",
      "content": "输入一个字符串，统计其中小写字母数量。",
      "options": null,
      "answer": "遍历字符串并判断字符范围。",
      "analysis": "核心是逐字符访问和计数变量。",
      "tags": ["tiku", "string"]
    }
  ],
  "materials": [],
  "teacherConstraints": {
    "durationMinutes": 45,
    "mode": "teacher-led",
    "outputs": ["courseware-slides.json", "deck.html", "teacher-script.md", "video-script.md", "courseware-package.json"]
  }
}
```

Agent usage:

- Requirement Agent converts `tiku-context.json` into `brief.md`; it should not ask for subject/topic again unless the context is incomplete.
- Outline Agent uses `knowledge.objectives`, `materials`, and question coverage to structure the lesson.
- Exercise Agent uses `questions` first. If `allowAiDraftForGaps` is true, it may add AI draft items, but must label them `source: ai-draft` and list the missing coverage.
- Review And Package Agent must copy Tiku identity into `courseware-slides.json`, `courseware-package.json`, and `generator-handoff.json`, especially `coursePackageId`, `lessonDbId`, `lessonId`, `nodeId`, `nodeName`, and `question_ids`.

## Courseware Slides Source Schema

`courseware-slides.json` is the primary editable source for Tiku courseware.
`deck.html`, PPTX, PDF, and `slides-manifest.json` are derived assets.

```json
{
  "schemaVersion": "tiku.coursewareSlides.v1",
  "coursePackageId": "bfe804cf-a05e-4b56-bb03-7933184a287e",
  "lessonDbId": "0096f000-2f79-4d95-af85-198ba3576d7c",
  "lessonId": "lesson-01",
  "title": "J01 入营测评 + CSP-J 赛制 + 环境 + 输入输出",
  "knowledgeIds": ["398"],
  "slides": [
    {
      "id": "slide-01",
      "order": 1,
      "type": "cover",
      "title": "CSP-J 从今天开始",
      "html": "<section><h1>CSP-J 从今天开始</h1></section>",
      "markdown": "# CSP-J 从今天开始",
      "notes": "教师可用的讲解提醒，不进入学生端。",
      "duration_minutes": 3,
      "student_visible": true
    }
  ]
}
```

Allowed `slides[].type` values: `cover`, `concept`, `example`, `practice`, `summary`.
Student-visible `html` must not contain: `江校`, `agent`, `Pilot`, `OpenMAIC`, `内部`, `验收`, `落库`, `metadata`, `courseware_jobs`, `老师讲稿`.

## Agent Tool Invocation

When the coordinator calls the HTML Slides Agent, use only these agent tool fields:

```json
{
  "description": "生成 J02 课件 slides",
  "prompt": "完整任务说明...",
  "subagent_type": "courseware-deck"
}
```

Do not use `role`, `agentRole`, or `type` as agent tool parameters. `agentRole` only belongs inside `courseware-agent-report.json`.

## Coordinator Pattern

For 12 lessons, the coordinator should process in small batches:

1. Run Requirement and Outline agents for lessons 1-3.
2. Run Teaching Script and Exercise agents for the same batch.
3. Run Deck and Video agents only after outline/script are ready.
4. Run Review And Package agent last.
5. Move to lessons 4-6 after the first batch is packaged.

This keeps context small and makes failures resumable per lesson and per role.
