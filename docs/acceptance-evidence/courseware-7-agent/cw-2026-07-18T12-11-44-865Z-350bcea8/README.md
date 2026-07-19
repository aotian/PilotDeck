# Real Gateway E2E Evidence

This bundle captures the completed isolated run `cw-2026-07-18T12-11-44-865Z-350bcea8` from `/tmp/pilotdeck-final-real-e2e.5dWmsL/real-gateway-7-agent-hq-final`.

The run used the real PilotDeck Gateway, Agent Tool, formal courseware subagent runtime, fixture Tiku context, and a local temporary UI API. It completed Requirement, Outline, parallel Script/Exercise, Deck style preview and approval, full Deck generation, targeted visual repair, Video, Review, the shared validator, PPTX export, and PDF export. Final status is `awaiting-teacher-approval`; publishing remains disabled.

Key evidence:

- `agent-run.json`: authoritative nine-phase state; seven Agent phases are `ready`.
- `reports/`: seven independent reports with `subagentType`, `subagentId`, `sessionId`, model, files written, and lifecycle evidence.
- `visual-quality-report.json`: 11/11 real Chrome metrics non-null, all slides pass, no overflow.
- `screenshots/` and `contact-sheet.png`: all 11 rendered pages and the contact sheet.
- `design-brief.json`, `approved-style.json`, `style-previews/`: high-quality style checkpoint and selected `style-b`.
- `courseware-package.json`, `generator-handoff.json`: Review outputs; `publish.allowed=false`.
- `courseware.pptx`, `courseware.pdf`, `pptx-export.json`, `pdf-export.json`: PilotDeck-derived exports; OpenMAIC renderer was not used.
- `acceptance-summary.json`, `real-gateway-e2e-result.json`, `test-results.md`: concise acceptance facts and command results.

No production Tiku, Teach, Learn, or OpenMAIC publish/binding API was called. J01 was not modified. No API key, Gateway token, cookie, or production payload is included.
