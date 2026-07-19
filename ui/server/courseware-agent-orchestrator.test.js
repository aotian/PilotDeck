import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCoursewareAgentOrchestrator } from './courseware-agent-orchestrator.js';
import { createGatewayCoursewareAgentRunner } from './courseware-agent-runner.js';
import { readCoursewareAgentRun, updateCoursewareAgentRunState } from './courseware-agent-state.js';
import { prepareCoursewareFullRebuild, writeCoursewareRunContracts } from './courseware-run-policy.js';
import {
    FakeCoursewareAgentRunner,
    createFakeRenderer,
    fakeDeriveAssets,
    fakeVisualQuality,
} from './testing/fake-courseware-agent-runner.js';

const tempDirs = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Courseware 7-Agent orchestrator', () => {
    it('runs the complete deterministic chain and preserves seven independent reports', async () => {
        const workspace = createWorkspace({ outputTargets: ['html', 'pptx', 'video'] });
        const runner = new FakeCoursewareAgentRunner({ delayMs: 5 });
        const orchestrator = createTestOrchestrator(runner);
        const result = await orchestrator.run({ projectPath: workspace, runId: 'run-complete' });

        expect(result.status).toBe('awaiting-teacher-approval');
        expect(startedRoles(runner)).toEqual([
            'courseware-requirement',
            'courseware-outline',
            'courseware-script',
            'courseware-exercise',
            'courseware-deck',
            'courseware-video',
            'courseware-review',
        ]);
        for (const role of startedRoles(runner)) {
            const reportPath = path.join(workspace, 'reports', 'run-complete', `${role}.json`);
            expect(fs.existsSync(reportPath), role).toBe(true);
            const report = readJson(reportPath);
            expect(report.subagentType).toBe(role);
            expect(report.subagentId).toContain(role);
            expect(report.lifecycleEvents).toHaveLength(2);
        }
        const run = readCoursewareAgentRun(workspace);
        expect(run.phases.map((phase) => phase.id)).toEqual([
            'requirement', 'outline', 'script', 'exercise', 'deck', 'video', 'review', 'teacher-approval', 'publish',
        ]);
        expect(run.visualQuality.status).toBe('pass');
        expect(run.phases.find((phase) => phase.id === 'deck').checkpoint).toBe('deck-content-ready');

        const deckCallsBeforeResume = startedRoles(runner).filter((role) => role === 'courseware-deck').length;
        const resumed = await orchestrator.run({ projectPath: workspace, runId: 'run-complete' });
        expect(resumed.status).toBe('awaiting-teacher-approval');
        expect(startedRoles(runner).filter((role) => role === 'courseware-deck')).toHaveLength(deckCallsBeforeResume);
    });

    it('starts script and exercise only after outline and allows them to overlap', async () => {
        const workspace = createWorkspace({ runId: 'run-parallel' });
        const runner = new FakeCoursewareAgentRunner({ delayMs: 20 });
        await createTestOrchestrator(runner).run({ projectPath: workspace, runId: 'run-parallel' });

        const outlineComplete = runner.calls.findIndex((call) => call.role === 'courseware-outline' && call.event === 'completed');
        const scriptStart = runner.calls.findIndex((call) => call.role === 'courseware-script' && call.event === 'started');
        const exerciseStart = runner.calls.findIndex((call) => call.role === 'courseware-exercise' && call.event === 'started');
        expect(scriptStart).toBeGreaterThan(outlineComplete);
        expect(exerciseStart).toBeGreaterThan(outlineComplete);
        expect(runner.overlap).toContain('courseware-exercise+courseware-script');
    });

    it('keeps coordinator state writes out of real Gateway Runner role evidence during parallel phases', async () => {
        const workspace = createWorkspace({ runId: 'run-gateway-parallel' });
        const runner = createGatewayCoursewareAgentRunner({
            runChat: createParallelGatewayFixture(),
            model: 'fake/gateway-model',
        });
        const result = await createTestOrchestrator(runner).run({
            projectPath: workspace,
            runId: 'run-gateway-parallel',
        });

        expect(result.status).toBe('awaiting-teacher-approval');
        for (const role of ['courseware-script', 'courseware-exercise']) {
            const report = readJson(path.join(workspace, 'reports', 'run-gateway-parallel', `${role}.json`));
            expect(report.status).toBe('ready');
            expect(report.blockers.join(' ')).not.toContain('agent-run.json');
            expect(report.coordinatorWritesObserved).toContain('agent-run.json');
            expect(report.filesWritten).not.toContain('agent-run.json');
            expect(report.filesWritten.some((fileName) => (
                fileName.includes(role === 'courseware-script' ? 'courseware-exercise' : 'courseware-script')
            ))).toBe(false);
            expect(report.checks).toContainEqual(expect.objectContaining({
                name: 'coordinator-write-isolation',
                status: 'pass',
            }));
        }
    });

    it('propagates an exercise blocker and never runs deck, video, or review', async () => {
        const workspace = createWorkspace({ runId: 'run-blocked' });
        const runner = new FakeCoursewareAgentRunner({ blockedPhase: 'exercise', blocker: 'Tiku question scope is missing' });
        const result = await createTestOrchestrator(runner).run({ projectPath: workspace, runId: 'run-blocked' });

        expect(result.status).toBe('blocked');
        expect(startedRoles(runner)).not.toContain('courseware-deck');
        expect(startedRoles(runner)).not.toContain('courseware-video');
        expect(startedRoles(runner)).not.toContain('courseware-review');
        const run = readCoursewareAgentRun(workspace);
        expect(run.phases.find((phase) => phase.id === 'deck').status).toBe('skipped');
        expect(run.phases.find((phase) => phase.id === 'deck').blockers).toContain('Tiku question scope is missing');
    });

    it('rejects a deck that claims completion without its required output', async () => {
        const workspace = createWorkspace({ runId: 'run-missing-deck' });
        const runner = new FakeCoursewareAgentRunner({ missingOutputPhase: 'deck' });
        const result = await createTestOrchestrator(runner).run({ projectPath: workspace, runId: 'run-missing-deck' });
        expect(result.status).toBe('blocked');
        expect(fs.existsSync(path.join(workspace, 'courseware-slides.json'))).toBe(false);
        expect(readCoursewareAgentRun(workspace).phases.find((phase) => phase.id === 'deck').status).toBe('failed');
    });

    it('pauses high-quality generation for three style previews and resumes the same run after approval', async () => {
        const workspace = createWorkspace({ runId: 'run-hq', generationMode: 'high-quality' });
        const runner = new FakeCoursewareAgentRunner();
        const orchestrator = createTestOrchestrator(runner);
        const paused = await orchestrator.run({ projectPath: workspace, runId: 'run-hq', renderer: createFakeRenderer() });

        expect(paused.status).toBe('awaiting-style-approval');
        expect(paused.runId).toBe('run-hq');
        expect(fs.existsSync(path.join(workspace, 'courseware-slides.json'))).toBe(false);
        for (const styleId of ['style-a', 'style-b', 'style-c']) {
            expect(fs.existsSync(path.join(workspace, 'style-previews', styleId, 'preview.png'))).toBe(true);
        }
        const upstreamCalls = startedRoles(runner).slice(0, 4);
        const resumed = await orchestrator.approveStyle({
            projectPath: workspace,
            runId: 'run-hq',
            styleId: 'style-b',
            teacherNotes: 'Use the systems map direction.',
            renderer: createFakeRenderer(),
        });
        expect(resumed.runId).toBe('run-hq');
        expect(resumed.status).toBe('awaiting-teacher-approval');
        expect(readJson(path.join(workspace, 'approved-style.json')).teacherApprovedStyleId).toBe('style-b');
        expect(startedRoles(runner).filter((role) => upstreamCalls.includes(role))).toEqual(upstreamCalls);
        expect(startedRoles(runner).filter((role) => role === 'courseware-deck')).toHaveLength(2);
    });

    it('does not disguise a high-quality failure as a template success', async () => {
        const workspace = createWorkspace({ runId: 'run-hq-fail', generationMode: 'high-quality' });
        const runner = new FakeCoursewareAgentRunner({ blockedPhase: 'deck', blocker: 'visual preview generation failed' });
        const result = await createTestOrchestrator(runner).run({
            projectPath: workspace,
            runId: 'run-hq-fail',
            renderer: createFakeRenderer(),
        });
        expect(result.status).toBe('blocked');
        expect(result.degraded).toBe(false);
        expect(fs.existsSync(path.join(workspace, 'courseware-slides.json'))).toBe(false);
    });

    it('clears stale descendant blockers after a Deck preview retry succeeds', async () => {
        const workspace = createWorkspace({ runId: 'run-hq-retry', generationMode: 'high-quality' });
        const failedRunner = new FakeCoursewareAgentRunner({ blockedPhase: 'deck', blocker: 'preview files missing' });
        const failed = await createTestOrchestrator(failedRunner).run({
            projectPath: workspace,
            runId: 'run-hq-retry',
            renderer: createFakeRenderer(),
        });
        expect(failed.status).toBe('blocked');

        const resumed = await createTestOrchestrator(new FakeCoursewareAgentRunner()).run({
            projectPath: workspace,
            runId: 'run-hq-retry',
            renderer: createFakeRenderer(),
        });

        expect(resumed.status).toBe('awaiting-style-approval');
        expect(resumed.blockers).toEqual([]);
        const run = readCoursewareAgentRun(workspace);
        for (const phaseId of ['video', 'review', 'teacher-approval', 'publish']) {
            const phase = run.phases.find((candidate) => candidate.id === phaseId);
            expect(phase.status).toBe('pending');
            expect(phase.blockers).toEqual([]);
        }
    });

    it('patches only target slides, refreshes derived exports, and reruns review validation', async () => {
        const workspace = createWorkspace({ runId: 'run-patch', generationMode: 'high-quality' });
        const runner = new FakeCoursewareAgentRunner({ mutateAllOnRepair: true });
        const orchestrator = createTestOrchestrator(runner);
        await orchestrator.run({ projectPath: workspace, runId: 'run-patch', renderer: createFakeRenderer() });
        await orchestrator.approveStyle({
            projectPath: workspace,
            runId: 'run-patch',
            styleId: 'style-b',
            renderer: createFakeRenderer(),
        });
        const before = readJson(path.join(workspace, 'courseware-slides.json'));
        const beforePptxMtime = fs.statSync(path.join(workspace, 'courseware.pptx')).mtimeMs;

        const result = await orchestrator.patchSlides({
            projectPath: workspace,
            runId: 'run-patch',
            patchScope: 'Clarify slide-03 trace',
            targetSlideIds: ['slide-03'],
            allowedWrites: ['courseware-slides.json'],
            renderer: createFakeRenderer(),
        });
        const after = readJson(path.join(workspace, 'courseware-slides.json'));

        expect(result.status).toBe('awaiting-teacher-approval');
        expect(after.slides.find((slide) => slide.id === 'slide-03').title).toContain('repaired');
        expect(after.slides.filter((slide) => slide.id !== 'slide-03')).toEqual(
            before.slides.filter((slide) => slide.id !== 'slide-03'),
        );
        expect(fs.statSync(path.join(workspace, 'courseware.pptx')).mtimeMs).toBeGreaterThanOrEqual(beforePptxMtime);
        expect(startedRoles(runner).filter((role) => role === 'courseware-review')).toHaveLength(2);
        const history = readCoursewareAgentRun(workspace).patch.history;
        expect(history).toHaveLength(1);
        expect(history[0].validationResult).toMatchObject({ visualQuality: 'pass', sharedValidator: 'pass' });
    });

    it('blocks a no-op patch before derived assets, Review, or teacher approval', async () => {
        const workspace = createWorkspace({ runId: 'run-no-op-patch' });
        const runner = new FakeCoursewareAgentRunner({ noOpRepair: true });
        const orchestrator = createTestOrchestrator(runner);
        await orchestrator.run({ projectPath: workspace, runId: 'run-no-op-patch' });
        const reviewCallsBefore = startedRoles(runner).filter((role) => role === 'courseware-review').length;

        const result = await orchestrator.patchSlides({
            projectPath: workspace,
            runId: 'run-no-op-patch',
            patchScope: 'Clarify slide-03 without changing other pages',
            targetSlideIds: ['slide-03'],
            allowedWrites: ['courseware-slides.json'],
        });

        expect(result.status).toBe('blocked');
        expect(result.patchResult.changedSlideIds).toEqual([]);
        expect(result.patchResult.validationResult).toBe('failed');
        expect(result.blockers.join(' ')).toContain('no effective changes');
        expect(startedRoles(runner).filter((role) => role === 'courseware-review')).toHaveLength(reviewCallsBefore);
        const run = readCoursewareAgentRun(workspace);
        expect(run.phases.find((phase) => phase.id === 'deck').status).toBe('failed');
        expect(run.publish.allowed).toBe(false);
    });

    it('repairs all explicit visual failures in one bounded batch by default', async () => {
        const workspace = createWorkspace({ runId: 'run-batched-visual-repair' });
        const runner = new FakeCoursewareAgentRunner();
        let visualCalls = 0;
        const visualQuality = async (projectPath, runId, options = {}) => {
            const report = await fakeVisualQuality(projectPath, runId, options);
            visualCalls += 1;
            if (visualCalls === 1) {
                report.status = 'fail';
                report.slides = report.slides.map((slide) => ({
                    ...slide,
                    status: 'fail',
                    revisionRequired: true,
                    issues: [{ check: 'readability', severity: 'error', detail: 'Minimum font 14px is too small' }],
                }));
                fs.writeFileSync(path.join(projectPath, 'visual-quality-report.json'), `${JSON.stringify(report, null, 2)}\n`);
            }
            return report;
        };
        const orchestrator = createCoursewareAgentOrchestrator({
            runner,
            deriveAssets: fakeDeriveAssets,
            visualQuality,
            validateWorkspace: async () => ({ ok: true, issues: [], checks: [] }),
        });

        const result = await orchestrator.run({
            projectPath: workspace,
            runId: 'run-batched-visual-repair',
            maxVisualRepairSlides: 6,
        });

        expect(result.status).toBe('awaiting-teacher-approval');
        const repairCalls = runner.calls.filter((call) => call.event === 'started' && call.action === 'repair');
        expect(repairCalls.map((call) => call.targetSlideIds)).toEqual([[
            'slide-01', 'slide-02', 'slide-03', 'slide-04', 'slide-05', 'slide-06',
        ]]);
        expect(readCoursewareAgentRun(workspace).patch.history).toHaveLength(1);
    });

    it('skips the Deck repair agent when deterministic target repair passes visual recheck', async () => {
        const workspace = createWorkspace({ runId: 'run-deterministic-repair' });
        const runner = new FakeCoursewareAgentRunner();
        const baseWriteOutputs = runner.writeOutputs.bind(runner);
        runner.writeOutputs = (request) => {
            baseWriteOutputs(request);
            if (request.phase !== 'deck' || request.action !== 'produce') return;
            const slidesPath = path.join(request.projectPath, 'courseware-slides.json');
            const deck = readJson(slidesPath);
            deck.slides[0].html = '<section style="background:#ff5c9a"><h1 style="font-size:16px;color:#ffffff">Repair locally</h1></section>';
            fs.writeFileSync(slidesPath, `${JSON.stringify(deck, null, 2)}\n`);
        };
        const visualQuality = async (projectPath, runId, options = {}) => {
            const report = await fakeVisualQuality(projectPath, runId, options);
            const deck = readJson(path.join(projectPath, 'courseware-slides.json'));
            const target = deck.slides.find((slide) => slide.id === 'slide-01');
            const needsRepair = /font-size:\s*16px|color:\s*#ffffff/i.test(target.html);
            report.slides[0] = needsRepair
                ? {
                    ...report.slides[0],
                    status: 'fail',
                    revisionRequired: true,
                    issues: [{ check: 'contrast', severity: 'error', detail: 'Fixture contrast failure' }],
                    metrics: {
                        minFontPx: 16,
                        smallestFontSamples: [{ selector: 'h1', text: 'Repair locally', size: 16 }],
                        minContrast: 2.9,
                        lowestContrastSamples: [{
                            selector: 'h1',
                            text: 'Repair locally',
                            foreground: 'rgb(255, 255, 255)',
                            background: 'rgb(255, 92, 154)',
                            ratio: 2.9,
                        }],
                    },
                }
                : report.slides[0];
            report.status = report.slides.every((slide) => slide.status === 'pass') ? 'pass' : 'partial';
            fs.writeFileSync(path.join(projectPath, 'visual-quality-report.json'), `${JSON.stringify(report, null, 2)}\n`);
            return report;
        };
        const orchestrator = createCoursewareAgentOrchestrator({
            runner,
            deriveAssets: fakeDeriveAssets,
            visualQuality,
            validateWorkspace: async () => ({ ok: true, issues: [], checks: [] }),
        });

        const result = await orchestrator.run({ projectPath: workspace, runId: 'run-deterministic-repair' });

        expect(result.status).toBe('awaiting-teacher-approval');
        expect(runner.calls.filter((call) => call.event === 'started' && call.action === 'repair')).toHaveLength(0);
        expect(readCoursewareAgentRun(workspace).patch.history).toContainEqual(expect.objectContaining({
            repairEngine: 'deterministic',
            changedSlideIds: ['slide-01'],
        }));
    });

    it('limits visual repair model work per resume and keeps the Deck content checkpoint', async () => {
        const workspace = createWorkspace({ runId: 'run-repair-budget' });
        const runner = new FakeCoursewareAgentRunner();
        const repaired = new Set();
        const visualQuality = async (projectPath, runId, options = {}) => {
            const report = await fakeVisualQuality(projectPath, runId, options);
            const repairCalls = runner.calls.filter((call) => call.event === 'started' && call.action === 'repair');
            for (const call of repairCalls) {
                for (const slideId of call.targetSlideIds || []) repaired.add(slideId);
            }
            report.slides = report.slides.map((slide) => repaired.has(slide.slideId)
                ? slide
                : {
                    ...slide,
                    status: 'fail',
                    revisionRequired: true,
                    issues: [{ check: 'readability', severity: 'error', detail: 'Fixture visual failure' }],
                });
            report.status = report.slides.every((slide) => slide.status === 'pass') ? 'pass' : 'partial';
            fs.writeFileSync(path.join(projectPath, 'visual-quality-report.json'), `${JSON.stringify(report, null, 2)}\n`);
            return report;
        };
        const orchestrator = createCoursewareAgentOrchestrator({
            runner,
            deriveAssets: fakeDeriveAssets,
            visualQuality,
            validateWorkspace: async () => ({ ok: true, issues: [], checks: [] }),
        });

        const first = await orchestrator.run({
            projectPath: workspace,
            runId: 'run-repair-budget',
            maxVisualRepairSlides: 1,
        });
        expect(first.status).toBe('blocked');
        expect(first.blockers.join(' ')).toContain('resume the same runId');
        expect(runner.calls.filter((call) => call.event === 'started' && call.action === 'repair')).toHaveLength(1);
        expect(readCoursewareAgentRun(workspace).phases.find((phase) => phase.id === 'deck').checkpoint).toBe('deck-content-ready');

        const deckProduceCalls = runner.calls.filter((call) => (
            call.event === 'started' && call.role === 'courseware-deck' && call.action === 'produce'
        )).length;
        const second = await orchestrator.run({
            projectPath: workspace,
            runId: 'run-repair-budget',
            maxVisualRepairSlides: 1,
        });
        expect(second.status).toBe('blocked');
        expect(runner.calls.filter((call) => call.event === 'started' && call.action === 'repair')).toHaveLength(2);
        expect(runner.calls.filter((call) => (
            call.event === 'started' && call.role === 'courseware-deck' && call.action === 'produce'
        ))).toHaveLength(deckProduceCalls);
    });

    it('rolls back a failed visual repair and quarantines unauthorized artifacts', async () => {
        const workspace = createWorkspace({ runId: 'run-repair-rollback' });
        const runner = new FakeCoursewareAgentRunner();
        const baseRun = runner.run.bind(runner);
        let beforeRepair = null;
        runner.run = async (request) => {
            if (request.action !== 'repair') return baseRun(request);
            const slidesPath = path.join(request.projectPath, 'courseware-slides.json');
            beforeRepair = fs.readFileSync(slidesPath);
            const deck = JSON.parse(beforeRepair.toString('utf8'));
            deck.slides = deck.slides.map((slide) => ({ ...slide, title: `${slide.title} unauthorized` }));
            fs.writeFileSync(slidesPath, `${JSON.stringify(deck, null, 2)}\n`);
            fs.writeFileSync(path.join(request.projectPath, 'repair-debug.html'), '<p>debug</p>');
            return {
                status: 'failed',
                blockers: ['Writes outside role contract: repair-debug.html'],
                filesWritten: ['courseware-slides.json', 'repair-debug.html'],
            };
        };
        let visualCalls = 0;
        const visualQuality = async (projectPath, runId, options = {}) => {
            const report = await fakeVisualQuality(projectPath, runId, options);
            visualCalls += 1;
            if (visualCalls === 1) {
                report.status = 'partial';
                report.slides[0] = {
                    ...report.slides[0],
                    status: 'fail',
                    revisionRequired: true,
                    issues: [{ check: 'overflow', severity: 'error', detail: 'clipped' }],
                };
                fs.writeFileSync(path.join(projectPath, 'visual-quality-report.json'), `${JSON.stringify(report, null, 2)}\n`);
            }
            return report;
        };
        const orchestrator = createCoursewareAgentOrchestrator({
            runner,
            deriveAssets: fakeDeriveAssets,
            visualQuality,
            validateWorkspace: async () => ({ ok: true, issues: [], checks: [] }),
        });

        const result = await orchestrator.run({ projectPath: workspace, runId: 'run-repair-rollback' });

        expect(result.status).toBe('blocked');
        expect(fs.readFileSync(path.join(workspace, 'courseware-slides.json'))).toEqual(beforeRepair);
        expect(fs.existsSync(path.join(workspace, 'repair-debug.html'))).toBe(false);
        const history = readCoursewareAgentRun(workspace).patch.history;
        expect(history.at(-1)).toMatchObject({ rolledBack: true, validationResult: 'failed' });
        expect(fs.existsSync(path.join(workspace, history.at(-1).quarantinedFiles[0]))).toBe(true);
    });

    it('recovers from persisted state and only retries unfinished phases', async () => {
        const workspace = createWorkspace({ runId: 'run-recovery' });
        const firstRunner = new FakeCoursewareAgentRunner({ blockedPhase: 'script' });
        await createTestOrchestrator(firstRunner).run({ projectPath: workspace, runId: 'run-recovery' });
        const secondRunner = new FakeCoursewareAgentRunner();
        const result = await createTestOrchestrator(secondRunner).run({ projectPath: workspace, runId: 'run-recovery' });
        expect(result.status).toBe('awaiting-teacher-approval');
        expect(startedRoles(secondRunner)).not.toContain('courseware-requirement');
        expect(startedRoles(secondRunner)).not.toContain('courseware-outline');
        expect(startedRoles(secondRunner)).toContain('courseware-script');
    });

    it('skips optional video for PPT/HTML and still runs Review last', async () => {
        const workspace = createWorkspace({ runId: 'run-no-video', outputTargets: ['html', 'pptx'] });
        const runner = new FakeCoursewareAgentRunner({ blockedPhase: 'video' });
        const result = await createTestOrchestrator(runner).run({ projectPath: workspace, runId: 'run-no-video' });

        expect(result.status).toBe('awaiting-teacher-approval');
        expect(startedRoles(runner)).not.toContain('courseware-video');
        expect(startedRoles(runner).at(-1)).toBe('courseware-review');
        const video = readCoursewareAgentRun(workspace).phases.find((phase) => phase.id === 'video');
        expect(video).toMatchObject({ required: false, status: 'skipped' });
        expect(fs.existsSync(path.join(workspace, 'reports', 'run-no-video', 'courseware-video.json'))).toBe(true);
    });

    it('keeps explicitly requested video required and blocks Review on video failure', async () => {
        const workspace = createWorkspace({
            runId: 'run-required-video',
            outputTargets: ['html', 'pptx', 'video'],
        });
        const runner = new FakeCoursewareAgentRunner({ blockedPhase: 'video', blocker: 'Video model unavailable' });
        const result = await createTestOrchestrator(runner).run({
            projectPath: workspace,
            runId: 'run-required-video',
        });

        expect(result.status).toBe('blocked');
        expect(startedRoles(runner)).toContain('courseware-video');
        expect(startedRoles(runner)).not.toContain('courseware-review');
        expect(readCoursewareAgentRun(workspace).phases.find((phase) => phase.id === 'video').required).toBe(true);
    });

    it('hard-blocks a high-quality run when cumulative token budget is exceeded', async () => {
        const workspace = createWorkspace({
            runId: 'run-token-budget',
            generationMode: 'high-quality',
            budgetLimits: { inputTokens: 150, outputTokens: 10_000, modelCalls: 20, resumes: 3, revisions: 3 },
        });
        const runner = new FakeCoursewareAgentRunner({ usage: { inputTokens: 100, outputTokens: 10, modelCalls: 1 } });
        const result = await createTestOrchestrator(runner).run({
            projectPath: workspace,
            runId: 'run-token-budget',
            renderer: createFakeRenderer(),
        });

        expect(result.status).toBe('blocked');
        expect(result.degraded).toBe(false);
        expect(result.budgetUsage.inputTokens).toBe(200);
        expect(result.budgetStatus).toBe('exceeded');
        expect(startedRoles(runner)).toEqual(['courseware-requirement', 'courseware-outline']);
        const outlineReport = readJson(path.join(workspace, 'reports', 'run-token-budget', 'courseware-outline.json'));
        expect(outlineReport.budgetUsage.inputTokens).toBe(200);
    });

    it('marks automatic-draft budget exhaustion as degraded without pretending success', async () => {
        const workspace = createWorkspace({
            runId: 'run-budget-degraded',
            budgetLimits: { inputTokens: 50, outputTokens: 10_000, modelCalls: 20, resumes: 3, revisions: 3 },
        });
        const result = await createTestOrchestrator(new FakeCoursewareAgentRunner({
            usage: { inputTokens: 100, outputTokens: 10, modelCalls: 1 },
        })).run({ projectPath: workspace, runId: 'run-budget-degraded' });

        expect(result.status).toBe('blocked');
        expect(result.degraded).toBe(true);
        expect(result.degradedReason).toContain('inputTokens');
    });
});

describe('Courseware operation modes', () => {
    it('keeps reuse-existing read-only for courseware-slides.json', async () => {
        const workspace = createWorkspace({ runId: 'run-reuse', operationMode: 'reuse-existing', withSlides: true });
        const before = sha(path.join(workspace, 'courseware-slides.json'));
        const runner = new FakeCoursewareAgentRunner();
        const result = await createTestOrchestrator(runner).run({ projectPath: workspace, runId: 'run-reuse' });
        expect(result.status).toBe('awaiting-teacher-approval');
        expect(sha(path.join(workspace, 'courseware-slides.json'))).toBe(before);
        expect(startedRoles(runner)).toHaveLength(0);
    });

    it('never starts writing agents in audit-only mode', async () => {
        const workspace = createWorkspace({ runId: 'run-audit', operationMode: 'audit-only', withSlides: true });
        const runner = new FakeCoursewareAgentRunner();
        const result = await createTestOrchestrator(runner).run({ projectPath: workspace, runId: 'run-audit' });
        expect(result.status).toBe('ready');
        expect(startedRoles(runner)).toHaveLength(0);
    });

    it('blocks incremental-update without patch scope and allowed writes', async () => {
        const workspace = createWorkspace({ runId: 'run-incremental', operationMode: 'incremental-update', withSlides: true });
        const result = await createTestOrchestrator(new FakeCoursewareAgentRunner()).run({ projectPath: workspace, runId: 'run-incremental' });
        expect(result.status).toBe('blocked');
    });

    it('isolates old slides after snapshot and keeps them absent while full-rebuild awaits style approval', async () => {
        const workspace = createWorkspace({
            runId: 'run-rebuild',
            operationMode: 'full-rebuild',
            generationMode: 'high-quality',
            withSlides: true,
            prepareFullRebuild: true,
        });
        const sourceLock = readJson(path.join(workspace, 'source-lock.json'));
        expect(fs.existsSync(path.join(sourceLock.snapshotPath, 'courseware-slides.json'))).toBe(true);
        expect(readJson(path.join(sourceLock.snapshotPath, 'courseware-slides.json')).slides[0].html).toContain('Existing');
        expect(fs.existsSync(path.join(workspace, 'courseware-slides.json'))).toBe(false);

        const result = await createTestOrchestrator(new FakeCoursewareAgentRunner()).run({
            projectPath: workspace,
            runId: 'run-rebuild',
            renderer: createFakeRenderer(),
        });

        expect(result.status).toBe('awaiting-style-approval');
        expect(fs.existsSync(path.join(workspace, 'courseware-slides.json'))).toBe(false);
    });
});

function createTestOrchestrator(runner) {
    return createCoursewareAgentOrchestrator({
        runner,
        deriveAssets: fakeDeriveAssets,
        visualQuality: fakeVisualQuality,
        validateWorkspace: async () => ({ ok: true, issues: [], checks: [{ name: 'fixture-validator', status: 'pass' }] }),
        exportPptx: async (workspace, runId) => {
            fs.writeFileSync(path.join(workspace, 'courseware.pptx'), Buffer.from('fixture-pptx'));
            fs.writeFileSync(path.join(workspace, 'pptx-export.json'), JSON.stringify({ runId, sourceOfTruth: 'courseware-slides.json', openmaicRendererUsed: false }));
        },
        exportPdf: async (workspace) => fs.writeFileSync(path.join(workspace, 'courseware.pdf'), Buffer.from('fixture-pdf')),
    });
}

function createParallelGatewayFixture() {
    const outputWriter = new FakeCoursewareAgentRunner();
    const phaseByRole = {
        'courseware-requirement': 'requirement',
        'courseware-outline': 'outline',
        'courseware-script': 'script',
        'courseware-exercise': 'exercise',
        'courseware-deck': 'deck',
        'courseware-video': 'video',
        'courseware-review': 'review',
    };
    return async (prompt, options, writer) => {
        const role = prompt.match(/"subagent_type": "(courseware-[^"]+)"/)?.[1];
        const phase = phaseByRole[role];
        if (!phase) throw new Error(`Fixture could not resolve subagent role from prompt: ${role || 'missing'}`);
        const subagentId = `fixture-${role}`;
        writer.send({
            kind: 'agent_activity',
            phase: 'subagent',
            state: 'running',
            subagentType: role,
            subagentId,
            activityId: `subagent:${subagentId}`,
            startedAt: new Date().toISOString(),
        });
        if (phase === 'script') await delay(20);
        if (phase === 'exercise') await delay(50);
        if (phase === 'deck') {
            fs.writeFileSync(path.join(options.projectPath, 'design-brief.json'), JSON.stringify({
                schemaVersion: 'tongcheng.coursewareDesignBrief.v1',
                runId: 'run-gateway-parallel',
            }));
            fs.writeFileSync(path.join(options.projectPath, 'deck-plan.md'), '# Fixture deck plan\n');
        }
        outputWriter.writeOutputs({
            projectPath: options.projectPath,
            runId: 'run-gateway-parallel',
            phase,
            action: 'produce',
            operationMode: 'new-asset',
            generationMode: 'automatic-draft',
            lessonId: 'fixture-lesson',
        });
        fs.writeFileSync(path.join(options.projectPath, 'courseware-agent-report.json'), JSON.stringify({
            schemaVersion: 'tongcheng.coursewareAgentReport.v1',
            runId: 'run-gateway-parallel',
            agentRole: role,
            subagentType: role,
            lessonId: 'fixture-lesson',
            status: 'ready',
            inputsRead: [],
            filesWritten: [],
            blockers: [],
            checks: [],
        }));
        writer.send({
            kind: 'agent_activity',
            phase: 'subagent',
            state: 'completed',
            subagentType: role,
            subagentId,
            activityId: `subagent:${subagentId}`,
            subagentSuccess: true,
            endedAt: new Date().toISOString(),
        });
    };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createWorkspace(options = {}) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-courseware-orchestrator-'));
    tempDirs.push(workspace);
    fs.writeFileSync(path.join(workspace, 'tiku-context.json'), JSON.stringify({
        schemaVersion: 'tiku.courseContext.v1',
        source: 'fixture',
        coursePackage: { id: 'fixture-package', lessonId: 'fixture-lesson', lessonTitle: 'Fixture lesson' },
        questions: [{ question_id: 'q-1', knowledge_id: 'k-1', difficulty: 'easy', answer: '3', analysis: 'trace', source: 'tiku' }],
    }, null, 2));
    fs.writeFileSync(path.join(workspace, 'teacher-request.md'), '# Teacher request\n\nCreate a reusable classroom lesson.\n');
    if (options.withSlides) {
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify({
            schemaVersion: 'tiku.coursewareSlides.v1',
            slides: [{ id: 'slide-01', html: '<section><h1>Existing</h1></section>' }],
        }, null, 2));
    }
    const snapshot = options.prepareFullRebuild
        ? prepareCoursewareFullRebuild(workspace, options.runId || 'run-complete')
        : { snapshotPath: null };
    writeCoursewareRunContracts({
        projectPath: workspace,
        runId: options.runId || 'run-complete',
        operationMode: options.operationMode || 'new-asset',
        generationMode: options.generationMode || 'automatic-draft',
        tikuContext: readJson(path.join(workspace, 'tiku-context.json')),
        sourceLock: { fixture: true },
        snapshot,
        outputTargets: options.outputTargets,
        audience: options.audience,
        budgetLimits: options.budgetLimits,
    });
    return workspace;
}

function startedRoles(runner) {
    return runner.calls.filter((call) => call.event === 'started').map((call) => call.role);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
