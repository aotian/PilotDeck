---
name: tongcheng-courseware-handoff
description: Use for Tongcheng teaching courseware requests, including GESP/CSP lessons, classroom PPT, HTML courseware, Tiku/Teach integration, video scripts, candidate exercises, or requests mentioning 童澄课件、智能课件、Tiku、Teach、教学大纲、题库候选. Collect requirements and create/update a course asset package for the Tongcheng courseware pipeline.
---

# Tongcheng Courseware Handoff

This skill prepares assets for the Tongcheng courseware pipeline. It creates a structured course asset package that can be standardized, reviewed, saved, and published by Tongcheng systems.

## When To Use

Use this skill when the user asks for:

- Tongcheng AI courseware or intelligent courseware.
- GESP/CSP programming lessons or classroom courseware.
- Subject courseware for math, Chinese, English, physics, chemistry, or AI.
- PPT/HTML/video script generation that should enter the Tiku/Teach courseware workflow.
- Candidate exercises, homework, quizzes, or assessment items tied to courseware.

Use strong presentation design where useful, but always preserve the structured course asset package files below.

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
   - `generator-handoff.json`: machine-readable handoff manifest using schema `tiku.courseAsset.v1`.
   - `courseware-package.json`: same machine-readable package snapshot for import/review.

3. Tell the user to click the UI button `生成课件` or `提交生成审核` in the current course asset project. That button opens the Tongcheng courseware review and publishing flow.

4. If the handoff API is available, the target URL shape is:

   ```text
   /api/tongcheng/courseware-handoff/<projectName>
   ```

   The response URL opens the Tongcheng courseware review flow with `assetWorkspace`, `subject`, and optional `handoffToken`.

## Output Discipline

- Keep any generated PPT/HTML as source assets, but still write the structured package files.
- Keep teacher notes concise and practical.
- Treat exercises as candidates. They must be reviewed before entering Tiku.
- Final publishing is handled by the Tongcheng courseware pipeline from the asset package.
