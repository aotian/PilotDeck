---
name: tongcheng-courseware-handoff
description: Use for Tongcheng teaching courseware requests, including GESP/CSP lessons, classroom PPT, HTML courseware, Tiku/Teach integration, video scripts, candidate exercises, or requests mentioning 童澄课件、智能课件、Tiku、Teach、教学大纲、题库候选. Collect requirements and create/update a course asset package for the Tongcheng courseware pipeline; produce Tiku-ready HTML slides as the source of truth and preserve rendered deck/PPT exports as derived assets.
---

# Tongcheng Courseware Handoff

This skill prepares assets for the Tongcheng courseware pipeline. It creates a structured course asset package that can be standardized, reviewed, saved, and published by Tongcheng systems.

## Agent Protocol

Before starting a multi-lesson or multi-asset courseware task, read and follow `courseware-agent-protocol.md` in this skill directory.

Use the protocol to split work into bounded agent roles:

- Requirement Agent
- Outline Agent
- Teaching Script Agent
- Exercise Agent
- Deck Agent
- Video Agent
- Review And Package Agent

Each agent must write only its assigned files and a `courseware-agent-report.json` handoff report. Do not let one agent generate a full 12-lesson course, full deck, exercises, video script, and package in the same context.

## When To Use

Use this skill when the user asks for:

- Tongcheng AI courseware or intelligent courseware.
- GESP/CSP programming lessons or classroom courseware.
- Subject courseware for math, Chinese, English, physics, chemistry, or AI.
- PPT/HTML/video script generation that should enter the Tiku/Teach courseware workflow.
- Candidate exercises, homework, quizzes, or assessment items tied to courseware.

Use strong presentation design where useful. When the user asks for PPT/HTML classroom courseware, pair this workflow with `frontend-slides`: create `courseware-slides.json` as the high-quality editable HTML slide source, then render `deck.html`/PPT/PDF only as preview or export assets.

## Workflow

1. Clarify the teacher's intent only when essential. Prefer concise choices:
   - subject/template
   - grade/level
   - topic/knowledge point
   - output targets: HTML, PPT, video script, Tiku candidates
   - classroom mode: teacher-led, student self-study, hybrid

2. Create or update the selected workspace asset package. Prefer these files:
   - `brief.md`: teacher requirement, subject, level, topic, class duration, success criteria.
   - `course-outline.md`: structured teaching outline, section timing, learning path.
   - `teacher-script.md`: teacher-facing teaching flow, questions, board notes.
   - `exercises.md`: candidate exercises grouped as classroom practice, homework, quiz.
   - `pitfalls.md`: common mistakes and remediation.
   - `parent-feedback.md`: optional after-class feedback, not for HTML body.
   - `generator-notes.md`: internal generator handoff notes. Do not mention this internal file name to teachers.
   - `courseware-slides.json`: required primary source asset using schema `tiku.coursewareSlides.v1`; its `slides[].html` is student-visible editable HTML and `slides[].notes` is teacher-only guidance.
   - `deck.html`: derived preview/backup rendered from `courseware-slides.json`.
   - `slides-manifest.json`: optional derived slide index, style choice, section mapping, and export metadata.
   - `video-script.md`: optional Tutor-style video script draft for review, recording, or later rendering.
   - `courseware.html` or `index.html`: optional HTML courseware if the deck is not named `deck.html`.
   - `generator-handoff.json`: machine-readable handoff manifest using schema `tiku.courseAsset.v1`.
   - `courseware-package.json`: same machine-readable package snapshot for import/review.
   - `courseware-agent-report.json`: required per-agent handoff report using schema `tongcheng.coursewareAgentReport.v1`.

3. For program-level work such as 12 lessons, batch work in groups of 1-3 lessons. Finish the required reports and package refresh for a batch before starting the next batch.

4. Tell the user to click the UI button `交接发布` or `提交发布审核` in the current course asset project. That button opens the Tongcheng courseware review and publishing flow.

5. If the handoff API is available, the target URL shape is:

   ```text
   /api/tongcheng/courseware-handoff/<projectName>
   ```

   The response URL opens the Tongcheng courseware review flow with `assetWorkspace`, `subject`, and optional `handoffToken`.

## Output Discipline

- Keep `courseware-slides.json` as the first-class source asset. `deck.html`, PPTX, PDF, and `slides-manifest.json` are derived preview/export assets.
- Do not pass full slide HTML, decks, or model tool logs through chat text or model tool arguments when a file path is enough. Write the file into the workspace and reference it from `courseware-package.json`.
- Do not feed previous full tool logs or full generated files into the next agent. Pass only file paths, concise summaries, and `courseware-agent-report.json`.
- Keep teacher notes concise and practical.
- Treat exercises as candidates. They must be reviewed before entering Tiku.
- Final publishing is handled by the Tongcheng courseware pipeline from the asset package; when `courseware-slides.json` exists, preserve it as the visual/editing source and do not recreate it from `deck.html`.
