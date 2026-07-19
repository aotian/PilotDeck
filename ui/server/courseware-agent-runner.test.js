import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayCoursewareAgentRunner } from './courseware-agent-runner.js';

const tempDirs = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('gateway courseware agent runner', () => {
    it('records real subagent lifecycle fields for the requested subagent_type', async () => {
        const workspace = createDeckWorkspace();
        let capturedPrompt = '';
        const fakeRun = fakeGatewayRun({ writeDeckOutputs: true });
        const runChat = async (prompt, ...args) => {
            capturedPrompt = prompt;
            return fakeRun(prompt, ...args);
        };
        const runner = createGatewayCoursewareAgentRunner({ runChat, model: 'fake/gateway-model' });
        const result = await runner.run({
            projectPath: workspace,
            runId: 'run-evidence',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'automatic-draft',
            lessonId: 'fixture-lesson',
            coordinatorSessionId: 'web:s_fixture',
        });
        expect(result.status).toBe('ready');
        expect(result.subagentType).toBe('courseware-deck');
        expect(result.subagentId).toBe('subagent-courseware-deck');
        expect(result.sessionId).not.toBe('web:s_fixture');
        expect(result.sessionId).toMatch(/^web:s_/);
        expect(result.coordinatorSessionId).toBe('web:s_fixture');
        expect(result.lifecycleEvents.map((event) => event.state)).toEqual(['running', 'completed']);
        expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 300, totalTokens: 1500 });
        expect(result.modelCalls).toBe(3);
        expect(capturedPrompt).toContain('Call the Agent tool exactly once');
        expect(capturedPrompt).toContain('"subagent_type": "courseware-deck"');
        expect(fs.existsSync(path.join(workspace, result.gatewayDiagnosticPath))).toBe(true);
    });

    it('isolates every delegation from the reusable coordinator session', async () => {
        const workspace = createScriptWorkspace();
        const sessionKeys = [];
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (_prompt, options, writer) => {
                sessionKeys.push(options.sessionKey);
                fs.writeFileSync(path.join(options.projectPath, 'teacher-script.md'), '# Script\n');
                fs.writeFileSync(path.join(options.projectPath, 'courseware-agent-report.json'), JSON.stringify({
                    schemaVersion: 'tongcheng.coursewareAgentReport.v1',
                    agentRole: 'courseware-script',
                    subagentType: 'courseware-script',
                    status: 'ready',
                    blockers: [],
                    checks: [],
                }));
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'running', subagentType: 'courseware-script', subagentId: 'script-1' });
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'completed', subagentType: 'courseware-script', subagentId: 'script-1', subagentSuccess: true });
            },
        });
        const common = {
            projectPath: workspace,
            runId: 'run-session-isolation',
            phase: 'script',
            subagentType: 'courseware-script',
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'automatic-draft',
            lessonId: 'fixture-lesson',
            coordinatorSessionId: 'web:s_shared-coordinator',
        };

        const first = await runner.run(common);
        const second = await runner.run(common);

        expect(first.status).toBe('ready');
        expect(second.status).toBe('ready');
        expect(sessionKeys).toHaveLength(2);
        expect(sessionKeys[0]).not.toBe(sessionKeys[1]);
        expect(sessionKeys).not.toContain('web:s_shared-coordinator');
        expect(first.coordinatorSessionId).toBe('web:s_shared-coordinator');
        expect(second.coordinatorSessionId).toBe('web:s_shared-coordinator');
    });

    it('reserves enough output budget for all three high-quality style previews', async () => {
        const workspace = createDeckWorkspace();
        let capturedMaxOutputTokens = 0;
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (_prompt, options) => {
                capturedMaxOutputTokens = options.maxOutputTokens;
            },
        });

        const result = await runner.run({
            projectPath: workspace,
            runId: 'run-style-budget',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'style-preview',
            operationMode: 'new-asset',
            generationMode: 'high-quality',
            lessonId: 'fixture-lesson',
            maxOutputTokens: 20000,
        });

        expect(capturedMaxOutputTokens).toBe(60000);
        expect(result.status).toBe('failed');
        expect(result.blockers.join(' ')).toContain('No subagent_started evidence');
    });

    it('caps a role output budget at the remaining hard run budget', async () => {
        const workspace = createDeckWorkspace();
        let capturedMaxOutputTokens = 0;
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (_prompt, options) => {
                capturedMaxOutputTokens = options.maxOutputTokens;
            },
        });

        await runner.run({
            projectPath: workspace,
            runId: 'run-hard-output-budget',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'style-preview',
            operationMode: 'new-asset',
            generationMode: 'high-quality',
            lessonId: 'fixture-lesson',
            hardMaxOutputTokens: 9000,
        });

        expect(capturedMaxOutputTokens).toBe(9000);
    });

    it('reserves a larger budget for a complete high-quality deck', async () => {
        const workspace = createDeckWorkspace();
        fs.writeFileSync(path.join(workspace, 'approved-style.json'), '{}');
        let capturedMaxOutputTokens = 0;
        let capturedPrompt = '';
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (prompt, options) => {
                capturedPrompt = prompt;
                capturedMaxOutputTokens = options.maxOutputTokens;
            },
        });

        await runner.run({
            projectPath: workspace,
            runId: 'run-deck-budget',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'high-quality',
            lessonId: 'fixture-lesson',
        });

        expect(capturedMaxOutputTokens).toBe(80000);
        expect(capturedPrompt).toContain('initial full-deck creation, not an incremental patch');
        expect(capturedPrompt).toContain('must invoke write_file or edit_file');
        expect(capturedPrompt).toContain('__PILOTDECK_SLIDE_SENTINEL__');
        expect(capturedPrompt).toContain('append only 1-2 complete slides per edit_file call');
        expect(capturedPrompt).toContain('run a real JSON.parse check');
    });

    it('rejects a nonempty but truncated JSON required output', async () => {
        const workspace = createDeckWorkspace();
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (_prompt, options, writer) => {
                fs.writeFileSync(path.join(options.projectPath, 'design-brief.json'), '{}');
                fs.writeFileSync(path.join(options.projectPath, 'deck-plan.md'), '# plan');
                fs.writeFileSync(path.join(options.projectPath, 'courseware-slides.json'), '{"slides":[');
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'running', subagentType: 'courseware-deck', subagentId: 'deck-truncated' });
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'completed', subagentType: 'courseware-deck', subagentId: 'deck-truncated', subagentSuccess: true });
            },
        });

        const result = await runner.run({
            projectPath: workspace,
            runId: 'run-truncated-json',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'automatic-draft',
            lessonId: 'fixture-lesson',
        });

        expect(result.status).toBe('failed');
        expect(result.blockers.join(' ')).toContain('courseware-slides.json (invalid JSON)');
    });

    it('rejects a parseable deck that still contains the chunk-write sentinel', async () => {
        const workspace = createDeckWorkspace();
        fs.writeFileSync(path.join(workspace, 'approved-style.json'), '{}');
        fs.writeFileSync(path.join(workspace, 'design-brief.json'), '{}');
        fs.writeFileSync(path.join(workspace, 'deck-plan.md'), '# plan');
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify({
            slides: [
                completeSlide('slide-01', 1),
                { id: '__PILOTDECK_SLIDE_SENTINEL__' },
            ],
        }));
        let capturedPrompt = '';
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (prompt, options, writer) => {
                capturedPrompt = prompt;
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'running', subagentType: 'courseware-deck', subagentId: 'deck-sentinel' });
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'completed', subagentType: 'courseware-deck', subagentId: 'deck-sentinel', subagentSuccess: true });
            },
        });

        const result = await runner.run({
            projectPath: workspace,
            runId: 'run-sentinel-json',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'high-quality',
            lessonId: 'fixture-lesson',
        });

        expect(result.status).toBe('failed');
        expect(result.blockers.join(' ')).toContain('contains unfinished slide sentinel');
        expect(capturedPrompt).toContain('Exact validation failures at invocation start');
        expect(capturedPrompt).toContain('already has 1 complete slides (slide-01)');
        expect(capturedPrompt).toContain('first mutating tool call must be edit_file');
        expect(capturedPrompt).toContain('A narrative claim that the edit happened is a failed run');
    });

    it('rejects a deck that drops all real Tiku question references', async () => {
        const workspace = createDeckWorkspace();
        fs.writeFileSync(path.join(workspace, 'tiku-context.json'), JSON.stringify({
            schemaVersion: 'tiku.courseContext.v1',
            questions: [{ question_id: 'fixture-q-1', knowledge_id: 'fixture-k-1' }],
        }));
        let capturedPrompt = '';
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (prompt, options, writer) => {
                capturedPrompt = prompt;
                fs.writeFileSync(path.join(options.projectPath, 'design-brief.json'), '{}');
                fs.writeFileSync(path.join(options.projectPath, 'deck-plan.md'), '# plan');
                fs.writeFileSync(path.join(options.projectPath, 'courseware-slides.json'), JSON.stringify({
                    slides: [completeSlide('slide-01', 1)],
                }));
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'running', subagentType: 'courseware-deck', subagentId: 'deck-no-refs' });
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'completed', subagentType: 'courseware-deck', subagentId: 'deck-no-refs', subagentSuccess: true });
            },
        });

        const result = await runner.run({
            projectPath: workspace,
            runId: 'run-question-ref-coverage',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'automatic-draft',
            lessonId: 'fixture-lesson',
        });

        expect(result.status).toBe('failed');
        expect(result.blockers.join(' ')).toContain('slides contain no question_refs');
        expect(capturedPrompt).toContain('at least one student-visible slide must include question_refs');
        expect(capturedPrompt).toContain('never invent or silently drop Tiku IDs');
    });

    it('rejects a non-ai-draft question reference outside the Tiku context', async () => {
        const workspace = createDeckWorkspace();
        fs.writeFileSync(path.join(workspace, 'tiku-context.json'), JSON.stringify({
            schemaVersion: 'tiku.courseContext.v1',
            questions: [{ question_id: 'fixture-q-1', knowledge_id: 'fixture-k-1' }],
        }));
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (_prompt, options, writer) => {
                fs.writeFileSync(path.join(options.projectPath, 'design-brief.json'), '{}');
                fs.writeFileSync(path.join(options.projectPath, 'deck-plan.md'), '# plan');
                fs.writeFileSync(path.join(options.projectPath, 'courseware-slides.json'), JSON.stringify({
                    slides: [{
                        ...completeSlide('slide-01', 1),
                        question_refs: [{ source: 'tiku', question_id: 'unknown-q' }],
                    }],
                }));
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'running', subagentType: 'courseware-deck', subagentId: 'deck-unknown-ref' });
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'completed', subagentType: 'courseware-deck', subagentId: 'deck-unknown-ref', subagentSuccess: true });
            },
        });

        const result = await runner.run({
            projectPath: workspace,
            runId: 'run-question-ref-unknown',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'automatic-draft',
            lessonId: 'fixture-lesson',
        });

        expect(result.status).toBe('failed');
        expect(result.blockers.join(' ')).toContain('question_ref unknown-q is not present');
    });

    it('does not carry a stale compatibility-report blocker into a successful retry', async () => {
        const workspace = createDeckWorkspace();
        fs.writeFileSync(path.join(workspace, 'courseware-agent-report.json'), JSON.stringify({
            schemaVersion: 'tongcheng.coursewareAgentReport.v1',
            agentRole: 'courseware-deck',
            subagentType: 'courseware-deck',
            status: 'failed',
            blockers: ['courseware-slides.json (invalid JSON)'],
        }));
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (_prompt, options, writer) => {
                fs.writeFileSync(path.join(options.projectPath, 'design-brief.json'), '{}');
                fs.writeFileSync(path.join(options.projectPath, 'deck-plan.md'), '# plan');
                fs.writeFileSync(path.join(options.projectPath, 'courseware-slides.json'), JSON.stringify({
                    slides: [completeSlide('slide-01', 1)],
                }));
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'running', subagentType: 'courseware-deck', subagentId: 'deck-retry' });
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'completed', subagentType: 'courseware-deck', subagentId: 'deck-retry', subagentSuccess: true });
            },
        });

        const result = await runner.run({
            projectPath: workspace,
            runId: 'run-stale-root-report',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'automatic-draft',
            lessonId: 'fixture-lesson',
        });

        expect(result.status).toBe('ready');
        expect(result.blockers).toEqual([]);
    });

    it('rejects a repair lifecycle that makes no effective deck change', async () => {
        const workspace = createDeckWorkspace();
        fs.writeFileSync(path.join(workspace, 'approved-style.json'), '{}');
        fs.writeFileSync(path.join(workspace, 'visual-quality-report.json'), JSON.stringify({
            slides: [{ slideId: 'slide-01', issues: [{ check: 'readability', detail: 'Minimum font 14px is too small' }] }],
        }));
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify({
            slides: [completeSlide('slide-01', 1), completeSlide('slide-02', 2)],
        }));
        let capturedPrompt = '';
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (prompt, _options, writer) => {
                capturedPrompt = prompt;
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'running', subagentType: 'courseware-deck', subagentId: 'deck-noop-repair' });
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'completed', subagentType: 'courseware-deck', subagentId: 'deck-noop-repair', subagentSuccess: true });
            },
        });

        const result = await runner.run({
            projectPath: workspace,
            runId: 'run-noop-repair',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'repair',
            operationMode: 'incremental-update',
            generationMode: 'high-quality',
            lessonId: 'fixture-lesson',
            targetSlideIds: ['slide-01'],
        });

        expect(result.status).toBe('failed');
        expect(result.blockers).toContain('Deck repair made no effective change to courseware-slides.json');
        expect(capturedPrompt).toContain('visual-quality-report.json');
        expect(capturedPrompt).toContain('slide-01: readability: Minimum font 14px is too small');
        expect(capturedPrompt).toContain('Current target slide objects are provided here');
        expect(capturedPrompt).toContain('\\"id\\": \\"slide-01\\"');
        expect(capturedPrompt).not.toContain('\\"id\\": \\"slide-02\\"');
        expect(capturedPrompt).toContain('Do not list the workspace');
        expect(capturedPrompt).toContain('first subagent tool call must be edit_file');
        expect(capturedPrompt).toContain('Bash, Node, Python, generated helper scripts');
        expect(capturedPrompt).toContain('raise all target text below 18px');
        expect(capturedPrompt).toContain('A no-op repair is a failed run');
    });

    it('states the exact style-preview schema consumed by the validator', async () => {
        const workspace = createDeckWorkspace();
        let capturedPrompt = '';
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (prompt) => {
                capturedPrompt = prompt;
            },
        });

        await runner.run({
            projectPath: workspace,
            runId: 'run-style-schema',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'style-preview',
            operationMode: 'new-asset',
            generationMode: 'high-quality',
            lessonId: 'fixture-lesson',
        });

        for (const field of ['styleId', 'designRationale', 'informationHierarchy', 'layoutFamilies', 'diagramMode', 'codeVisualMode', 'interactionPattern', 'illustrationMode']) {
            expect(capturedPrompt).toContain(field);
        }
        expect(capturedPrompt).toContain('must differ structurally, not only by color');
        expect(capturedPrompt).toContain('Persist previews one style at a time');
        expect(capturedPrompt).toContain('invoke write_file or edit_file for every missing file');
        expect(capturedPrompt).toContain('run test -s for every required preview path');
        expect(capturedPrompt).toContain('Outputs missing or invalid at invocation start');
    });

    it('passes prior validation blockers into a retry prompt', async () => {
        const workspace = createDeckWorkspace();
        let capturedPrompt = '';
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (prompt) => {
                capturedPrompt = prompt;
            },
        });

        await runner.run({
            projectPath: workspace,
            runId: 'run-retry-blockers',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'style-preview',
            operationMode: 'new-asset',
            generationMode: 'high-quality',
            lessonId: 'fixture-lesson',
            previousBlockers: ['style-a: styleId mismatch', 'layout families are identical'],
        });

        expect(capturedPrompt).toContain('This is a retry');
        expect(capturedPrompt).toContain('style-a: styleId mismatch');
        expect(capturedPrompt).toContain('layout families are identical');
        expect(capturedPrompt).toContain('authorized to replace that invalid output');
        expect(capturedPrompt).toContain('do not treat mere file existence as completion');
    });

    it('requires review outputs to be written directly before running the shared validator', async () => {
        const workspace = createDeckWorkspace();
        for (const fileName of [
            'video-script.md',
            'asset-request.json',
            'source-lock.json',
            'agent-run.json',
            'visual-quality-report.json',
        ]) {
            fs.writeFileSync(path.join(workspace, fileName), fileName.endsWith('.json') ? '{}' : '# video');
        }
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify({
            slides: [completeSlide('slide-01', 1)],
        }));
        let capturedPrompt = '';
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (prompt) => {
                capturedPrompt = prompt;
            },
        });

        await runner.run({
            projectPath: workspace,
            runId: 'run-review-write-order',
            phase: 'review',
            subagentType: 'courseware-review',
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'high-quality',
            lessonId: 'fixture-lesson',
        });

        expect(capturedPrompt).toContain('first subagent tool call must be write_file for courseware-package.json');
        expect(capturedPrompt).toContain('second subagent tool call must be write_file for generator-handoff.json');
        expect(capturedPrompt).toContain('Do not use Bash, Node, Python, a heredoc');
        expect(capturedPrompt).toContain('After both required files exist, run the shared validator');
        expect(capturedPrompt).toContain('publish.allowed=false');
    });

    it('stops the coordinator turn after the requested subagent completes', async () => {
        const workspace = createDeckWorkspace();
        let stopMatched = false;
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (_prompt, options, writer) => {
                const started = { type: 'tool_call_started', toolName: 'agent' };
                const completed = {
                    type: 'agent_status',
                    event: 'subagent_completed',
                    detail: { subagentType: 'courseware-deck', subagentId: 'deck-once', success: true },
                };
                options.onGatewayEvent(started);
                options.onGatewayEvent(completed);
                stopMatched = options.stopWhenGatewayEvent(completed);
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'running', subagentType: 'courseware-deck', subagentId: 'deck-once' });
                writer.send({ kind: 'agent_activity', phase: 'subagent', state: 'completed', subagentType: 'courseware-deck', subagentId: 'deck-once', subagentSuccess: true });
                const workspacePath = options.projectPath;
                fs.writeFileSync(path.join(workspacePath, 'design-brief.json'), '{}');
                fs.writeFileSync(path.join(workspacePath, 'deck-plan.md'), '# plan');
                fs.writeFileSync(path.join(workspacePath, 'courseware-slides.json'), JSON.stringify({ slides: [completeSlide('slide-01', 1)] }));
            },
        });

        const result = await runner.run({
            projectPath: workspace,
            runId: 'run-stop-after-completion',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'automatic-draft',
            lessonId: 'fixture-lesson',
        });

        expect(stopMatched).toBe(true);
        expect(result.status).toBe('ready');
        expect(result.agentToolCallCount).toBe(1);
    });

    it('fails a deck lifecycle that completes without courseware-slides.json', async () => {
        const workspace = createDeckWorkspace();
        const runner = createGatewayCoursewareAgentRunner({ runChat: fakeGatewayRun({ writeDeckOutputs: false }) });
        const result = await runner.run({
            projectPath: workspace,
            runId: 'run-missing-output',
            phase: 'deck',
            subagentType: 'courseware-deck',
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'automatic-draft',
            lessonId: 'fixture-lesson',
        });
        expect(result.status).toBe('failed');
        expect(result.blockers.join(' ')).toContain('courseware-slides.json');
    });

    it('still rejects undeclared role writes while isolating coordinator-managed state', async () => {
        const workspace = createScriptWorkspace();
        const role = 'courseware-script';
        const runner = createGatewayCoursewareAgentRunner({
            runChat: async (_prompt, options, writer) => {
                writer.send({
                    kind: 'agent_activity',
                    phase: 'subagent',
                    state: 'running',
                    subagentType: role,
                    subagentId: 'subagent-courseware-script',
                });
                fs.writeFileSync(path.join(options.projectPath, 'teacher-script.md'), '# Script\n');
                fs.writeFileSync(path.join(options.projectPath, 'agent-run.json'), JSON.stringify({ runId: 'run-write-scope' }));
                fs.writeFileSync(path.join(options.projectPath, 'rogue.txt'), 'outside role contract');
                fs.writeFileSync(path.join(options.projectPath, 'courseware-agent-report.json'), JSON.stringify({
                    schemaVersion: 'tongcheng.coursewareAgentReport.v1',
                    agentRole: role,
                    subagentType: role,
                    status: 'ready',
                    blockers: [],
                    checks: [],
                }));
                writer.send({
                    kind: 'agent_activity',
                    phase: 'subagent',
                    state: 'completed',
                    subagentType: role,
                    subagentId: 'subagent-courseware-script',
                    subagentSuccess: true,
                });
            },
        });
        const result = await runner.run({
            projectPath: workspace,
            runId: 'run-write-scope',
            phase: 'script',
            subagentType: role,
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'automatic-draft',
            lessonId: 'fixture-lesson',
            coordinatorManagedWrites: ['agent-run.json'],
        });

        expect(result.status).toBe('failed');
        expect(result.blockers.join(' ')).toContain('rogue.txt');
        expect(result.blockers.join(' ')).not.toContain('Writes outside role contract: agent-run.json');
        expect(result.coordinatorWritesObserved).toEqual(['agent-run.json']);
        expect(result.filesWritten).not.toContain('agent-run.json');
    });
});

function fakeGatewayRun({ writeDeckOutputs }) {
    return async (_prompt, options, writer) => {
        const workspace = options.projectPath;
        const role = 'courseware-deck';
        const subagentId = `subagent-${role}`;
        const stagingPath = path.join(workspace, 'reports', path.basename(workspace).includes('unused') ? 'unused' : '', '.staging');
        writer.send({
            kind: 'agent_activity',
            phase: 'subagent',
            state: 'running',
            subagentType: role,
            subagentId,
            activityId: `subagent:${subagentId}`,
            startedAt: new Date().toISOString(),
        });
        if (writeDeckOutputs) {
            fs.writeFileSync(path.join(workspace, 'design-brief.json'), JSON.stringify({ schemaVersion: 'tongcheng.coursewareDesignBrief.v1' }));
            fs.writeFileSync(path.join(workspace, 'deck-plan.md'), '# plan');
            fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify({
                schemaVersion: 'tiku.coursewareSlides.v1',
                slides: [completeSlide('slide-01', 1)],
            }));
        }
        const report = {
            schemaVersion: 'tongcheng.coursewareAgentReport.v1',
            agentRole: role,
            subagentType: role,
            lessonId: 'fixture-lesson',
            status: 'ready',
            inputsRead: ['brief.md'],
            filesWritten: writeDeckOutputs ? ['design-brief.json', 'deck-plan.md', 'courseware-slides.json'] : [],
            blockers: [],
            checks: [],
        };
        fs.writeFileSync(path.join(workspace, 'courseware-agent-report.json'), JSON.stringify(report));
        writer.send({
            kind: 'agent_activity',
            phase: 'subagent',
            state: 'completed',
            subagentType: role,
            subagentId,
            activityId: `subagent:${subagentId}`,
            subagentSuccess: true,
            subagentUsage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
            subagentTurns: 2,
            endedAt: new Date().toISOString(),
        });
    };
}

function createDeckWorkspace() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-runner-'));
    tempDirs.push(workspace);
    for (const fileName of ['brief.md', 'course-outline.md', 'pitfalls.md', 'teacher-script.md', 'exercises.md']) {
        fs.writeFileSync(path.join(workspace, fileName), `# ${fileName}`);
    }
    fs.writeFileSync(path.join(workspace, 'tiku-context.json'), '{}');
    return workspace;
}

function createScriptWorkspace() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-script-runner-'));
    tempDirs.push(workspace);
    for (const fileName of ['brief.md', 'course-outline.md', 'pitfalls.md']) {
        fs.writeFileSync(path.join(workspace, fileName), `# ${fileName}`);
    }
    return workspace;
}

function completeSlide(id, order) {
    return {
        id,
        order,
        type: 'concept',
        title: `Slide ${order}`,
        html: `<section><h1>Slide ${order}</h1></section>`,
    };
}
