# Test Results

Captured 2026-07-19 (Asia/Shanghai).

| Command | Result | Exit |
| --- | --- | ---: |
| `pnpm --dir ui exec vitest run server/courseware-agent-orchestrator.test.js server/courseware-agent-runner.test.js server/courseware-visual-quality.test.js server/courseware-derived-assets.test.js server/courseware-run-policy.test.js` | 5 files, 57/57 | 0 |
| `pnpm --dir ui test` | 17 files, 122/122 | 0 |
| `pnpm run build` | Root TypeScript build passed | 0 |
| `pnpm --dir ui run build` | Vite build passed; existing chunk-size warning only | 0 |
| `pnpm test` | Root build and compiled Agent output-budget test 1/1 | 0 |
| `cd /Users/tongcheng/Projects/AI-practice && node --test test/courseware-validator.test.js` | Shared validator 16/16 | 0 |
| Local temporary API resume with real Gateway and Agent Tool | Seven roles ready; awaiting-teacher-approval | HTTP 200 |
| Final real Chrome full-deck recheck | 11/11 metrics non-null; all pass | 0 |
| `unzip -t .../courseware.pptx` | 11-slide OOXML package valid | 0 |
| `pdfinfo .../courseware.pdf` | 11 pages, 960 x 540 pt | 0 |
| `git diff --check` | clean | 0 |
| J01 Git status and modification-time checks | no output | 0 |

The first Review attempt is intentionally retained in diagnostics/history as a failed output-contract run: a malformed subagent Bash argument left both required outputs absent, and the Runner blocked it. The Review prompt was then hardened, its regression test passed, and retry 2 wrote both files before the shared validator passed.
