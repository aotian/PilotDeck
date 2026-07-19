import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    COURSEWARE_PHASE_DEFINITIONS,
    getCoursewarePhase,
    readCoursewareAgentRun,
    requestsVideo,
    summarizeCoursewareAgentRun,
    updateCoursewareAgentRunState,
} from './courseware-agent-state.js';
import { writeCoursewareRunReport } from './courseware-run-policy.js';
import {
    applyDeterministicCoursewareVisualRepairs,
    mergeTargetedCoursewareSlidePatch,
    renderCoursewareStylePreviews,
    runCoursewareVisualQuality,
    snapshotCoursewareSlidePatch,
} from './courseware-visual-quality.js';

const PHASE_DEPENDENCIES = Object.freeze({
    requirement: [],
    outline: ['requirement'],
    script: ['outline'],
    exercise: ['outline'],
    deck: ['script', 'exercise'],
    video: ['deck'],
    review: ['deck'],
    'teacher-approval': ['review'],
    publish: ['teacher-approval'],
});

const PARALLEL_COORDINATOR_MANAGED_WRITES = Object.freeze(['agent-run.json']);

export function createCoursewareAgentOrchestrator(dependencies = {}) {
    if (!dependencies.runner?.run) throw new Error('Courseware orchestrator requires a runner');
    const validateWorkspace = dependencies.validateWorkspace || (async () => ({ ok: true, issues: [], checks: [] }));
    const deriveAssets = dependencies.deriveAssets || (async () => ({}));
    const renderStyles = dependencies.renderStylePreviews || renderCoursewareStylePreviews;
    const visualQuality = dependencies.visualQuality || runCoursewareVisualQuality;
    const deterministicVisualRepair = dependencies.deterministicVisualRepair || applyDeterministicCoursewareVisualRepairs;
    const exportPptx = dependencies.exportPptx || null;
    const exportPdf = dependencies.exportPdf || null;

    return {
        async run(options) {
            const projectPath = path.resolve(options.projectPath);
            let run = requireRun(projectPath, options.runId);
            const operationMode = run.operationMode;

            if (options.countResume === true || (!['requested', 'running'].includes(run.status) && run.status !== 'awaiting-style-approval')) {
                const resumeBlockers = incrementBudgetCounter(projectPath, 'resumes');
                if (resumeBlockers.length) return blockForBudget(projectPath, run.currentPhase || 'requirement', resumeBlockers);
                run = requireRun(projectPath, options.runId);
            }

            if (operationMode === 'audit-only') {
                return runAuditOnly({ projectPath, run, validateWorkspace });
            }
            if (operationMode === 'reuse-existing') {
                return runReuseExisting({ projectPath, run, validateWorkspace });
            }
            if (operationMode === 'incremental-update') {
                return blockInvalidIncrementalRun(projectPath, run);
            }
            if (!['new-asset', 'full-rebuild'].includes(operationMode)) {
                throw new Error(`Unsupported courseware operation mode: ${operationMode}`);
            }

            run = updateCoursewareAgentRunState(projectPath, {
                status: 'running',
                coordinatorSessionId: run.coordinatorSessionId || options.coordinatorSessionId || `web:s_${crypto.randomUUID()}`,
            });

            const common = {
                projectPath,
                runId: run.runId,
                operationMode,
                generationMode: run.generationMode,
                lessonId: run.target?.lessonId,
                coordinatorSessionId: run.coordinatorSessionId,
                model: options.model,
                maxOutputTokens: options.maxOutputTokens,
                outputTargets: run.outputTargets,
                audience: run.audience,
            };

            const requirement = await executePhase({ projectPath, phaseId: 'requirement', runner: dependencies.runner, common });
            if (!isReady(requirement)) return propagateAndSummarize(projectPath, 'requirement', requirement.blockers);

            const outline = await executePhase({ projectPath, phaseId: 'outline', runner: dependencies.runner, common });
            if (!isReady(outline)) return propagateAndSummarize(projectPath, 'outline', outline.blockers);

            const branchResults = await Promise.all([
                executePhase({
                    projectPath,
                    phaseId: 'script',
                    runner: dependencies.runner,
                    common: {
                        ...common,
                        concurrentAllowedWrites: ['exercises.md', 'homework.md', 'oj-exercises.md', 'edu-exercises.md'],
                        coordinatorManagedWrites: PARALLEL_COORDINATOR_MANAGED_WRITES,
                    },
                }),
                executePhase({
                    projectPath,
                    phaseId: 'exercise',
                    runner: dependencies.runner,
                    common: {
                        ...common,
                        concurrentAllowedWrites: ['teacher-script.md'],
                        coordinatorManagedWrites: PARALLEL_COORDINATOR_MANAGED_WRITES,
                    },
                }),
            ]);
            const failedBranch = branchResults.find((result) => !isReady(result));
            if (failedBranch) return propagateAndSummarize(projectPath, failedBranch.phaseId, failedBranch.blockers);

            run = requireRun(projectPath, run.runId);
            if (run.generationMode === 'high-quality' && !run.style?.teacherApprovedStyleId) {
                return runStylePreviewCheckpoint({
                    projectPath,
                    run,
                    runner: dependencies.runner,
                    common,
                    renderStyles,
                    renderer: options.renderer,
                });
            }

            const persistedRun = requireRun(projectPath, run.runId);
            const persistedDeck = getCoursewarePhase(persistedRun, 'deck');
            if (persistedDeck?.checkpoint === 'deck-content-ready') {
                const pendingDescendants = Object.fromEntries(
                    ['video', 'review', 'teacher-approval', 'publish']
                        .filter((phaseId) => getCoursewarePhase(persistedRun, phaseId)?.status !== 'ready')
                        .map((phaseId) => [phaseId, { status: 'pending', blockers: [] }]),
                );
                updateCoursewareAgentRunState(projectPath, {
                    status: 'running',
                    currentPhase: 'deck',
                    phaseUpdates: {
                        deck: { status: 'ready', blockers: [] },
                        ...pendingDescendants,
                    },
                });
            } else {
                const deck = await executePhase({
                    projectPath,
                    phaseId: 'deck',
                    runner: dependencies.runner,
                    common,
                    action: 'produce',
                });
                if (!isReady(deck)) return propagateAndSummarize(projectPath, 'deck', deck.blockers);
                updateCoursewareAgentRunState(projectPath, {
                    phaseUpdates: {
                        deck: { checkpoint: 'deck-content-ready' },
                    },
                });
            }

            await deriveAssets({ projectPath, runId: run.runId, generationMode: run.generationMode });
            let visualReport = await visualQuality(projectPath, run.runId, {
                renderer: options.renderer,
                audience: run.audience,
            });
            updateCoursewareAgentRunState(projectPath, {
                visualQuality: {
                    status: visualReport.status,
                    reportPath: 'visual-quality-report.json',
                    failedSlideIds: failedSlideIds(visualReport),
                    revisedSlideIds: visualReport.revisedSlideIds || [],
                },
            });

            if (visualReport.status !== 'pass') {
                const repairResult = await repairFailedSlides({
                    projectPath,
                    run: requireRun(projectPath, run.runId),
                    runner: dependencies.runner,
                    common,
                    deriveAssets,
                    visualQuality,
                    deterministicVisualRepair,
                    renderer: options.renderer,
                    visualReport,
                    maxSlides: resolveVisualRepairSlideLimit(options.maxVisualRepairSlides, failedSlideIds(visualReport).length),
                });
                if (!repairResult.ok) return propagateAndSummarize(projectPath, 'deck', repairResult.blockers);
                visualReport = repairResult.visualReport;
            }

            if (run.generationMode === 'high-quality') {
                if (exportPptx) await exportPptx(projectPath, run.runId, { generationMode: run.generationMode });
                if (exportPdf) await exportPdf(projectPath, run.runId, { generationMode: run.generationMode });
            }

            if (requestsVideo(requireRun(projectPath, run.runId).outputTargets)) {
                const video = await executePhase({ projectPath, phaseId: 'video', runner: dependencies.runner, common });
                if (!isReady(video)) return propagateAndSummarize(projectPath, 'video', video.blockers);
            } else {
                skipOptionalVideo(projectPath, run.runId);
            }

            const review = await executePhase({ projectPath, phaseId: 'review', runner: dependencies.runner, common });
            if (!isReady(review)) return propagateAndSummarize(projectPath, 'review', review.blockers);

            const validation = await validateWorkspace(projectPath, {
                publishTarget: 'learn',
                audience: run.audience,
            });
            if (!validation?.ok) {
                const blockers = normalizeValidationBlockers(validation);
                mergeReviewValidationReport(projectPath, run.runId, review, validation, blockers);
                updateCoursewareAgentRunState(projectPath, {
                    status: 'blocked',
                    currentPhase: 'review',
                    phaseUpdates: {
                        review: {
                            status: 'blocked',
                            completedAt: new Date().toISOString(),
                            blockers,
                        },
                    },
                });
                return summarize(projectPath);
            }
            mergeReviewValidationReport(projectPath, run.runId, review, validation, []);

            updateCoursewareAgentRunState(projectPath, {
                status: 'awaiting-teacher-approval',
                currentPhase: 'teacher-approval',
                phaseUpdates: {
                    review: { status: 'ready', blockers: [] },
                    'teacher-approval': { status: 'pending', blockers: [] },
                },
                publish: {
                    allowed: false,
                    reason: 'Shared validator passed; teacher approval and Tiku canonical publish are still required.',
                },
            });
            return summarize(projectPath, { validation });
        },

        async approveStyle(options) {
            const projectPath = path.resolve(options.projectPath);
            const run = requireRun(projectPath, options.runId);
            if (run.generationMode !== 'high-quality') throw new Error('Style approval only applies to high-quality generation');
            if (run.status !== 'awaiting-style-approval') throw new Error(`Run is not awaiting style approval: ${run.status}`);
            const styleId = String(options.styleId || '');
            if (!['style-a', 'style-b', 'style-c'].includes(styleId)) throw new Error(`Unknown styleId: ${styleId}`);
            const stylePath = path.join(projectPath, 'style-previews', styleId, 'style.json');
            const selectedStyle = readJson(stylePath);
            if (!selectedStyle) throw new Error(`Missing style preview asset: ${stylePath}`);
            const approved = {
                schemaVersion: 'tongcheng.coursewareApprovedStyle.v1',
                runId: run.runId,
                lessonId: run.target?.lessonId || null,
                teacherApprovedStyleId: styleId,
                approvedAt: new Date().toISOString(),
                designTokens: selectedStyle.designTokens || {},
                layouts: selectedStyle.layouts || selectedStyle.layoutFamilies || [],
                illustration: selectedStyle.illustration || { mode: selectedStyle.illustrationMode || null },
                codeBlocks: selectedStyle.codeBlocks || { mode: selectedStyle.codeVisualMode || null },
                questionCards: selectedStyle.questionCards || { revealMode: selectedStyle.questionRevealMode || null },
                teacherNotes: String(options.teacherNotes || ''),
            };
            fs.writeFileSync(path.join(projectPath, 'approved-style.json'), `${JSON.stringify(approved, null, 2)}\n`, 'utf8');
            updateCoursewareAgentRunState(projectPath, {
                status: 'running',
                currentPhase: 'deck',
                style: {
                    teacherApprovedStyleId: styleId,
                    approvedStylePath: 'approved-style.json',
                },
                phaseUpdates: {
                    deck: { status: 'pending', blockers: [], checkpoint: 'style-approved' },
                },
            });
            return this.run({ ...options, projectPath, runId: run.runId, countResume: true });
        },

        async patchSlides(options) {
            const projectPath = path.resolve(options.projectPath);
            const run = requireRun(projectPath, options.runId);
            const targetSlideIds = Array.isArray(options.targetSlideIds) ? options.targetSlideIds.map(String) : [];
            if (!options.patchScope || !targetSlideIds.length) throw new Error('incremental patch requires patchScope and targetSlideIds');
            const allowedWrites = Array.isArray(options.allowedWrites) ? options.allowedWrites : [];
            if (!allowedWrites.includes('courseware-slides.json')) throw new Error('incremental patch must allow courseware-slides.json');
            const revisionBlockers = incrementBudgetCounter(projectPath, 'revisions');
            if (revisionBlockers.length) return blockForBudget(projectPath, 'deck', revisionBlockers);
            const patchId = `patch-${crypto.randomUUID().slice(0, 8)}`;
            const beforeSnapshot = snapshotCoursewareSlidePatch(projectPath, run.runId, patchId);
            const result = await executePhase({
                projectPath,
                phaseId: 'deck',
                runner: dependencies.runner,
                common: {
                    projectPath,
                    runId: run.runId,
                    subagentType: 'courseware-deck',
                    operationMode: 'incremental-update',
                    generationMode: run.generationMode,
                    lessonId: run.target?.lessonId,
                    coordinatorSessionId: run.coordinatorSessionId,
                    model: options.model,
                    outputTargets: run.outputTargets,
                    audience: run.audience,
                    targetSlideIds,
                    patchScope: options.patchScope,
                    allowedWrites,
                },
                action: 'repair',
                force: true,
            });
            if (!isReady(result)) return { ...summarize(projectPath), patchResult: result };
            const audit = mergeTargetedCoursewareSlidePatch({
                projectPath,
                beforeSnapshot,
                targetSlideIds,
                patchScope: options.patchScope,
                allowedWrites,
            });
            if (audit.validationResult !== 'pass') {
                const blockers = audit.blockers?.length
                    ? audit.blockers
                    : ['Incremental patch validation failed'];
                const current = requireRun(projectPath, run.runId);
                updateCoursewareAgentRunState(projectPath, {
                    status: 'blocked',
                    currentPhase: 'deck',
                    patch: {
                        ...current.patch,
                        patchScope: options.patchScope,
                        allowedWrites,
                        targetSlideIds,
                        history: [...(current.patch?.history || []), {
                            patchId,
                            ...audit,
                            validationResult: {
                                patch: 'failed',
                                visualQuality: 'not-run',
                                sharedValidator: 'not-run',
                                blockers,
                            },
                            completedAt: new Date().toISOString(),
                        }],
                    },
                    phaseUpdates: {
                        deck: { status: 'failed', blockers },
                        review: { status: 'blocked', blockers },
                        'teacher-approval': { status: 'skipped', blockers },
                    },
                    publish: {
                        allowed: false,
                        reason: 'Incremental patch made no effective change and cannot publish.',
                    },
                });
                return { ...summarize(projectPath), patchResult: audit };
            }
            await deriveAssets({ projectPath, runId: run.runId, generationMode: run.generationMode });
            const report = await visualQuality(projectPath, run.runId, {
                renderer: options.renderer,
                revisedSlideIds: targetSlideIds,
                audience: run.audience,
            });
            let review = null;
            let validation = null;
            let blockers = failedSlideIds(report).map((slideId) => `Visual quality failed after patch: ${slideId}`);
            if (report.status === 'pass') {
                if (run.generationMode === 'high-quality') {
                    if (exportPptx) await exportPptx(projectPath, run.runId, { generationMode: run.generationMode });
                    if (exportPdf) await exportPdf(projectPath, run.runId, { generationMode: run.generationMode });
                }
                review = await executePhase({
                    projectPath,
                    phaseId: 'review',
                    runner: dependencies.runner,
                    common: {
                        projectPath,
                        runId: run.runId,
                        operationMode: 'incremental-update',
                        generationMode: run.generationMode,
                        lessonId: run.target?.lessonId,
                        coordinatorSessionId: run.coordinatorSessionId,
                        model: options.model,
                        outputTargets: run.outputTargets,
                        audience: run.audience,
                    },
                    action: 'patch-review',
                    force: true,
                });
                if (isReady(review)) {
                    validation = await validateWorkspace(projectPath, {
                        publishTarget: 'learn',
                        audience: run.audience,
                    });
                    blockers = normalizeValidationBlockers(validation);
                    mergeReviewValidationReport(projectPath, run.runId, review, validation, blockers);
                } else {
                    blockers = review.blockers || ['Review agent failed after incremental patch'];
                }
            }
            const current = requireRun(projectPath, run.runId);
            const patchPassed = report.status === 'pass' && isReady(review) && validation?.ok;
            updateCoursewareAgentRunState(projectPath, {
                status: patchPassed ? 'awaiting-teacher-approval' : 'blocked',
                currentPhase: patchPassed ? 'teacher-approval' : 'review',
                visualQuality: {
                    status: report.status,
                    reportPath: 'visual-quality-report.json',
                    failedSlideIds: failedSlideIds(report),
                    revisedSlideIds: targetSlideIds,
                },
                patch: {
                    ...current.patch,
                    patchScope: options.patchScope,
                    allowedWrites,
                    targetSlideIds,
                    history: [...(current.patch?.history || []), {
                        patchId,
                        ...audit,
                        validationResult: {
                            visualQuality: report.status,
                            sharedValidator: validation?.ok === true ? 'pass' : validation ? 'fail' : 'not-run',
                            blockers,
                        },
                        completedAt: new Date().toISOString(),
                    }],
                },
                phaseUpdates: {
                    review: { status: patchPassed ? 'ready' : 'blocked', blockers },
                    'teacher-approval': { status: patchPassed ? 'pending' : 'skipped', blockers: patchPassed ? [] : blockers },
                },
                publish: {
                    allowed: false,
                    reason: patchPassed
                        ? 'Incremental patch passed Review and shared validation; teacher approval is still required.'
                        : 'Incremental patch is blocked and cannot publish.',
                },
            });
            return { ...summarize(projectPath), patchResult: audit, visualQuality: report, validation };
        },

        status(projectPath) {
            return summarize(path.resolve(projectPath));
        },
    };
}

async function executePhase({ projectPath, phaseId, runner, common, action = 'produce', force = false }) {
    let run = requireRun(projectPath, common.runId);
    const phase = getCoursewarePhase(run, phaseId);
    const previousBlockers = Array.isArray(phase?.blockers) ? phase.blockers.map(String) : [];
    if (!force && phase?.status === 'ready') return { phaseId, status: 'ready', skippedExisting: true, blockers: [] };
    const budgetBlockers = findBudgetExcess(run, { atLimit: true });
    if (budgetBlockers.length) {
        blockForBudget(projectPath, phaseId, budgetBlockers);
        return { phaseId, status: 'blocked', blockers: budgetBlockers, budgetExceeded: true };
    }
    const dependencyBlockers = blockedDependencies(run, phaseId);
    if (dependencyBlockers.length) {
        return { phaseId, status: 'blocked', blockers: dependencyBlockers };
    }
    const attempt = Number(phase?.attempts || 0) + 1;
    run = updateCoursewareAgentRunState(projectPath, {
        status: 'running',
        currentPhase: phaseId,
        phaseUpdates: {
            [phaseId]: {
                status: 'running',
                startedAt: phase?.startedAt || new Date().toISOString(),
                completedAt: null,
                blockers: [],
                attempts: attempt,
            },
        },
    });
    let result;
    try {
        result = await runner.run({
            ...common,
            phase: phaseId,
            subagentType: phase.owner,
            action,
            previousBlockers,
            hardMaxOutputTokens: remainingBudget(run, 'outputTokens'),
        });
    } catch (error) {
        result = {
            status: 'failed',
            blockers: [error instanceof Error ? error.message : String(error)],
            reportPath: phase.reportPath,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            modelCalls: 1,
        };
    }
    const budget = consumePhaseBudget(projectPath, result);
    const postBudgetBlockers = findBudgetExcess({ budget }, { atLimit: false });
    const status = result.status === 'ready' ? 'ready' : result.status === 'blocked' ? 'blocked' : 'failed';
    updateCoursewareAgentRunState(projectPath, {
        status: postBudgetBlockers.length ? 'blocked' : status === 'ready' ? 'running' : status,
        currentPhase: phaseId,
        coordinatorSessionId: result.coordinatorSessionId || run.coordinatorSessionId,
        degraded: postBudgetBlockers.length && run.generationMode === 'automatic-draft'
            ? true
            : run.degraded,
        degradedReason: postBudgetBlockers.length && run.generationMode === 'automatic-draft'
            ? postBudgetBlockers.join('; ')
            : run.degradedReason,
        budget: postBudgetBlockers.length
            ? { status: 'exceeded', exceeded: budgetExceededNames(budget), updatedAt: new Date().toISOString() }
            : { status: 'within-budget', exceeded: [], updatedAt: new Date().toISOString() },
        phaseUpdates: {
            [phaseId]: {
                status: postBudgetBlockers.length ? 'blocked' : status,
                completedAt: new Date().toISOString(),
                reportPath: result.reportPath || phase.reportPath,
                blockers: postBudgetBlockers.length ? postBudgetBlockers : result.blockers || [],
                subagentId: result.subagentId || null,
                sessionId: result.sessionId || result.coordinatorSessionId || null,
                model: result.model || null,
                action,
            },
        },
    });
    attachBudgetToRoleReport(projectPath, common.runId, phase.owner);
    return {
        phaseId,
        ...result,
        status: postBudgetBlockers.length ? 'blocked' : status,
        blockers: postBudgetBlockers.length ? postBudgetBlockers : result.blockers || [],
        budgetUsage: budget.usage,
    };
}

async function runStylePreviewCheckpoint({ projectPath, run, runner, common, renderStyles, renderer }) {
    const deckPhase = getCoursewarePhase(run, 'deck');
    if (deckPhase?.checkpoint !== 'style-preview-ready') {
        const beforeSlides = fileHash(path.join(projectPath, 'courseware-slides.json'));
        const preview = await executePhase({
            projectPath,
            phaseId: 'deck',
            runner,
            common,
            action: 'style-preview',
            force: true,
        });
        if (!isReady(preview)) return propagateAndSummarize(projectPath, 'deck', preview.blockers);
        const afterSlides = fileHash(path.join(projectPath, 'courseware-slides.json'));
        if (beforeSlides !== afterSlides) {
            return propagateAndSummarize(projectPath, 'deck', ['Deck agent changed courseware-slides.json before style approval']);
        }
        const rendered = await renderStyles(projectPath, { renderer });
        if (!rendered.ok) return propagateAndSummarize(projectPath, 'deck', rendered.issues);
        updateCoursewareAgentRunState(projectPath, {
            status: 'awaiting-style-approval',
            currentPhase: 'deck',
            style: {
                approvalRequired: true,
                teacherApprovedStyleId: null,
                previewPaths: rendered.previewPaths,
            },
            phaseUpdates: {
                deck: {
                    status: 'pending',
                    checkpoint: 'style-preview-ready',
                    blockers: [],
                },
                video: { status: 'pending', blockers: [] },
                review: { status: 'pending', blockers: [] },
                'teacher-approval': { status: 'pending', blockers: [] },
                publish: { status: 'pending', blockers: [] },
            },
        });
    } else {
        updateCoursewareAgentRunState(projectPath, {
            status: 'awaiting-style-approval',
            currentPhase: 'deck',
            phaseUpdates: {
                deck: { status: 'pending', checkpoint: 'style-preview-ready', blockers: [] },
                video: { status: 'pending', blockers: [] },
                review: { status: 'pending', blockers: [] },
                'teacher-approval': { status: 'pending', blockers: [] },
                publish: { status: 'pending', blockers: [] },
            },
        });
    }
    return summarize(projectPath);
}

async function repairFailedSlides({
    projectPath,
    run,
    runner,
    common,
    deriveAssets,
    visualQuality,
    deterministicVisualRepair,
    renderer,
    visualReport,
    maxSlides,
}) {
    const allTargets = prioritizeDeterministicVisualTargets(visualReport);
    if (!allTargets.length) return { ok: true, visualReport };
    const targets = allTargets.slice(0, maxSlides);
    const batches = [targets];
    for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        const revisionBlockers = incrementBudgetCounter(projectPath, 'revisions');
        if (revisionBlockers.length) return { ok: false, blockers: revisionBlockers };
        let batchComplete = false;
        let finalBlockers = [];
        for (let attempt = 1; attempt <= 1 && !batchComplete; attempt += 1) {
            const patchId = `visual-${crypto.randomUUID().slice(0, 8)}`;
            const beforeSnapshot = snapshotCoursewareSlidePatch(projectPath, run.runId, patchId);
            const patchScope = `Repair visual-quality failures for batch ${index + 1}/${batches.length}, attempt ${attempt}/1: ${batch.join(', ')}`;
            const deterministic = deterministicVisualRepair({
                projectPath,
                targetSlideIds: batch,
                visualReport: readJson(path.join(projectPath, 'visual-quality-report.json')) || visualReport,
            });
            if (deterministic.changedSlideIds.length) {
                const audit = mergeTargetedCoursewareSlidePatch({
                    projectPath,
                    beforeSnapshot,
                    targetSlideIds: batch,
                    patchScope: `${patchScope} [deterministic]`,
                    allowedWrites: ['courseware-slides.json'],
                });
                const latest = requireRun(projectPath, run.runId);
                updateCoursewareAgentRunState(projectPath, {
                    patch: {
                        ...latest.patch,
                        history: [...(latest.patch?.history || []), {
                            patchId,
                            ...audit,
                            repairEngine: 'deterministic',
                            fixes: deterministic.fixes,
                            completedAt: new Date().toISOString(),
                        }],
                    },
                });
                await deriveAssets({ projectPath, runId: run.runId, generationMode: run.generationMode });
                const deterministicReport = await visualQuality(projectPath, run.runId, {
                    renderer,
                    targetSlideIds: batch,
                    revisedSlideIds: [...new Set([...(visualReport.revisedSlideIds || []), ...batch])],
                    audience: run.audience,
                });
                const deterministicFailures = failedSlideIds(deterministicReport).filter((slideId) => batch.includes(slideId));
                if (!deterministicFailures.length) {
                    batchComplete = true;
                    visualReport = deterministicReport;
                    continue;
                }
            }
            const agentPatchId = deterministic.changedSlideIds.length ? `${patchId}-agent` : patchId;
            const agentBeforeSnapshot = deterministic.changedSlideIds.length
                ? snapshotCoursewareSlidePatch(projectPath, run.runId, agentPatchId)
                : beforeSnapshot;
            const repair = await executePhase({
                projectPath,
                phaseId: 'deck',
                runner,
                common: { ...common, targetSlideIds: batch, patchScope, allowedWrites: ['courseware-slides.json'] },
                action: 'repair',
                force: true,
            });
            if (!isReady(repair)) {
                const rollback = rollbackFailedVisualRepair({
                    projectPath,
                    runId: run.runId,
                    patchId: agentPatchId,
                    beforeSnapshot: agentBeforeSnapshot,
                    filesWritten: repair.filesWritten,
                });
                const latest = requireRun(projectPath, run.runId);
                finalBlockers = repair.blockers || ['Deck repair failed'];
                updateCoursewareAgentRunState(projectPath, {
                    patch: {
                        ...latest.patch,
                        history: [...(latest.patch?.history || []), {
                            patchId: agentPatchId,
                            patchScope,
                            targetSlideIds: batch,
                            beforeSnapshot: agentBeforeSnapshot,
                            changedFiles: repair.filesWritten || [],
                            validationResult: 'failed',
                            ...rollback,
                            completedAt: new Date().toISOString(),
                        }],
                    },
                });
                continue;
            }
            const audit = mergeTargetedCoursewareSlidePatch({
                projectPath,
                beforeSnapshot: agentBeforeSnapshot,
                targetSlideIds: batch,
                patchScope,
                allowedWrites: ['courseware-slides.json'],
            });
            const latest = requireRun(projectPath, run.runId);
            updateCoursewareAgentRunState(projectPath, {
                patch: {
                    ...latest.patch,
                history: [...(latest.patch?.history || []), { patchId: agentPatchId, repairEngine: 'agent', ...audit, completedAt: new Date().toISOString() }],
                },
            });
            if (audit.validationResult === 'pass') {
                batchComplete = true;
            } else {
                finalBlockers = audit.blockers?.length ? audit.blockers : ['Visual repair made no effective target-slide changes'];
            }
        }
        if (!batchComplete) return { ok: false, blockers: finalBlockers };
    }
    await deriveAssets({ projectPath, runId: run.runId, generationMode: run.generationMode });
    const nextReport = await visualQuality(projectPath, run.runId, {
        renderer,
        revisedSlideIds: [...new Set([...(visualReport.revisedSlideIds || []), ...targets])],
        audience: run.audience,
    });
    const remainingSlideIds = failedSlideIds(nextReport);
    const latest = requireRun(projectPath, run.runId);
    updateCoursewareAgentRunState(projectPath, {
        visualQuality: {
            status: nextReport.status,
            reportPath: 'visual-quality-report.json',
            failedSlideIds: remainingSlideIds,
            revisedSlideIds: nextReport.revisedSlideIds || targets,
        },
        phaseUpdates: { deck: { status: nextReport.status === 'pass' ? 'ready' : 'blocked' } },
    });
    if (nextReport.status === 'pass') return { ok: true, visualReport: nextReport };
    const attemptedStillFailing = remainingSlideIds.filter((slideId) => targets.includes(slideId));
    const blockers = attemptedStillFailing.length
        ? [`Visual quality still failing after targeted repair: ${attemptedStillFailing.join(', ')}`]
        : [
            `Visual repair checkpoint reached after ${targets.length} slide(s); resume the same runId for remaining slides: ${remainingSlideIds.join(', ')}`,
        ];
    return { ok: false, blockers };
}

function resolveVisualRepairSlideLimit(value, failedCount = 0) {
    const configured = value ?? process.env.TONGCHENG_COURSEWARE_MAX_VISUAL_REPAIR_SLIDES_PER_RUN ?? 24;
    const parsed = Number(configured);
    const limit = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 24;
    return failedCount > 0 ? Math.min(limit, failedCount) : limit;
}

function prioritizeDeterministicVisualTargets(visualReport) {
    const deterministicChecks = new Set([
        'css-validity',
        'contrast',
        'readability',
        'projection-legibility',
        'code-readability',
    ]);
    return (visualReport?.slides || [])
        .filter((slide) => slide.status === 'fail')
        .map((slide, index) => {
            const errorChecks = (slide.issues || [])
                .filter((item) => item.severity === 'error')
                .map((item) => item.check);
            const deterministicOnly = errorChecks.length > 0 && errorChecks.every((check) => deterministicChecks.has(check));
            return { slideId: String(slide.slideId), deterministicOnly, index };
        })
        .sort((left, right) => Number(right.deterministicOnly) - Number(left.deterministicOnly) || left.index - right.index)
        .map((entry) => entry.slideId);
}

function rollbackFailedVisualRepair({ projectPath, runId, patchId, beforeSnapshot, filesWritten = [] }) {
    const snapshotPath = path.join(projectPath, beforeSnapshot);
    const slidesPath = path.join(projectPath, 'courseware-slides.json');
    if (!fs.existsSync(snapshotPath)) throw new Error(`Visual repair rollback snapshot is missing: ${beforeSnapshot}`);
    fs.copyFileSync(snapshotPath, slidesPath);
    const rejectedRoot = path.join(projectPath, '.courseware-runs', runId, 'patches', patchId, 'rejected');
    const quarantinedFiles = [];
    for (const relativePath of filesWritten.map(String)) {
        if (relativePath === 'courseware-slides.json' || relativePath.startsWith('reports/')) continue;
        const sourcePath = path.resolve(projectPath, relativePath);
        if (!sourcePath.startsWith(`${path.resolve(projectPath)}${path.sep}`) || !fs.existsSync(sourcePath)) continue;
        const destinationPath = path.join(rejectedRoot, relativePath);
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.renameSync(sourcePath, destinationPath);
        quarantinedFiles.push(path.relative(projectPath, destinationPath));
    }
    return { rolledBack: true, quarantinedFiles };
}

async function runAuditOnly({ projectPath, run, validateWorkspace }) {
    const validation = await validateWorkspace(projectPath, { publishTarget: 'learn' });
    const blockers = normalizeValidationBlockers(validation);
    const phaseUpdates = Object.fromEntries(run.phases.map((phase) => [phase.id, {
        status: phase.id === 'publish' ? 'pending' : 'skipped',
        blockers: phase.id === 'publish' ? [] : ['audit-only does not start writing agents'],
    }]));
    updateCoursewareAgentRunState(projectPath, {
        status: validation?.ok ? 'ready' : 'blocked',
        currentPhase: 'review',
        phaseUpdates,
        publish: { allowed: false, reason: 'audit-only never publishes' },
    });
    return summarize(projectPath, { validation, blockers });
}

async function runReuseExisting({ projectPath, run, validateWorkspace }) {
    if (!fs.existsSync(path.join(projectPath, 'courseware-slides.json'))) {
        updateCoursewareAgentRunState(projectPath, { status: 'blocked', currentPhase: 'deck' });
        return summarize(projectPath, { blockers: ['reuse-existing requires courseware-slides.json'] });
    }
    const before = fileHash(path.join(projectPath, 'courseware-slides.json'));
    const validation = await validateWorkspace(projectPath, { publishTarget: 'learn' });
    const after = fileHash(path.join(projectPath, 'courseware-slides.json'));
    if (before !== after) throw new Error('reuse-existing validation modified courseware-slides.json');
    updateCoursewareAgentRunState(projectPath, {
        status: validation?.ok ? 'awaiting-teacher-approval' : 'blocked',
        currentPhase: validation?.ok ? 'teacher-approval' : 'review',
        phaseUpdates: Object.fromEntries(run.phases.map((phase) => [phase.id, {
            status: ['teacher-approval', 'publish'].includes(phase.id) ? 'pending' : 'skipped',
            blockers: [],
        }])),
        publish: { allowed: false, reason: 'Existing asset was revalidated; teacher approval is still required.' },
    });
    return summarize(projectPath, { validation });
}

function blockInvalidIncrementalRun(projectPath, run) {
    const patchScope = run.patch?.patchScope;
    const allowedWrites = run.patch?.allowedWrites || [];
    const blockers = [];
    if (!patchScope) blockers.push('incremental-update requires patchScope');
    if (!allowedWrites.length) blockers.push('incremental-update requires allowedWrites');
    if (!blockers.length) blockers.push('Use the incremental slide patch endpoint with explicit targetSlideIds');
    updateCoursewareAgentRunState(projectPath, { status: 'blocked', currentPhase: 'deck' });
    return summarize(projectPath, { blockers });
}

function propagateAndSummarize(projectPath, failedPhaseId, blockers = []) {
    const run = requireRun(projectPath);
    const normalizedBlockers = blockers?.length ? blockers.map(String) : [`${failedPhaseId} did not complete`];
    const descendants = descendantPhases(failedPhaseId);
    const phaseUpdates = {
        [failedPhaseId]: {
            status: getCoursewarePhase(run, failedPhaseId)?.status === 'failed' ? 'failed' : 'blocked',
            blockers: normalizedBlockers,
            completedAt: new Date().toISOString(),
        },
    };
    for (const phaseId of descendants) {
        const phase = getCoursewarePhase(run, phaseId);
        if (!phase || phase.status === 'ready') continue;
        phaseUpdates[phaseId] = { status: 'skipped', blockers: normalizedBlockers };
        if (phase.owner?.startsWith('courseware-')) {
            writeCoursewareRunReport(projectPath, run.runId, phase.owner, {
                status: 'skipped',
                lessonId: run.target?.lessonId || null,
                startedAt: null,
                completedAt: new Date().toISOString(),
                inputsRead: [],
                filesWritten: [],
                nextAgent: null,
                blockers: normalizedBlockers,
                checks: [{ name: 'dependency-ready', status: 'fail', detail: `Blocked by ${failedPhaseId}` }],
                model: null,
                sessionId: null,
            });
        }
    }
    updateCoursewareAgentRunState(projectPath, {
        status: 'blocked',
        currentPhase: failedPhaseId,
        phaseUpdates,
    });
    return summarize(projectPath);
}

function mergeReviewValidationReport(projectPath, runId, review, validation, blockers) {
    const report = {
        ...review,
        status: blockers.length ? 'blocked' : 'ready',
        blockers,
        checks: [
            ...(review.checks || []),
            {
                name: 'shared-courseware-validator',
                status: validation?.ok ? 'pass' : 'fail',
                detail: validation?.ok ? 'Shared validator passed' : `${blockers.length} blocking issue(s)`,
            },
        ],
        validation: {
            ok: Boolean(validation?.ok),
            issueCount: blockers.length,
        },
    };
    writeCoursewareRunReport(projectPath, runId, 'courseware-review', report);
    fs.writeFileSync(path.join(projectPath, 'courseware-agent-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function skipOptionalVideo(projectPath, runId) {
    const run = requireRun(projectPath, runId);
    const phase = getCoursewarePhase(run, 'video');
    if (phase?.status === 'ready' || phase?.status === 'skipped') return;
    const completedAt = new Date().toISOString();
    const blocker = 'Video was not requested by outputTargets; PPT/HTML review may proceed without it.';
    writeCoursewareRunReport(projectPath, runId, 'courseware-video', {
        status: 'skipped',
        lessonId: run.target?.lessonId || null,
        startedAt: null,
        completedAt,
        inputsRead: [],
        filesWritten: [],
        nextAgent: 'courseware-review',
        blockers: [],
        checks: [{ name: 'output-target', status: 'pass', detail: blocker }],
        model: null,
        sessionId: null,
        budgetUsage: run.budget?.usage || null,
    });
    updateCoursewareAgentRunState(projectPath, {
        phaseUpdates: {
            video: {
                required: false,
                status: 'skipped',
                completedAt,
                blockers: [],
                reportPath: `reports/${runId}/courseware-video.json`,
            },
        },
    });
}

function consumePhaseBudget(projectPath, result = {}) {
    const run = requireRun(projectPath);
    const current = run.budget?.usage || {};
    const usage = result.usage && typeof result.usage === 'object' ? result.usage : {};
    const nextUsage = {
        ...current,
        inputTokens: Number(current.inputTokens || 0) + nonNegativeNumber(usage.inputTokens),
        outputTokens: Number(current.outputTokens || 0) + nonNegativeNumber(usage.outputTokens),
        modelCalls: Number(current.modelCalls || 0) + nonNegativeNumber(result.modelCalls),
    };
    return updateCoursewareAgentRunState(projectPath, {
        budget: { usage: nextUsage, updatedAt: new Date().toISOString() },
    }).budget;
}

function incrementBudgetCounter(projectPath, counter, amount = 1) {
    const run = requireRun(projectPath);
    const limit = Number(run.budget?.limits?.[counter] || 0);
    const current = Number(run.budget?.usage?.[counter] || 0);
    const next = current + amount;
    if (limit > 0 && next > limit) {
        return [`Courseware run budget exceeded: ${counter} ${next}/${limit}`];
    }
    updateCoursewareAgentRunState(projectPath, {
        budget: {
            usage: { ...run.budget?.usage, [counter]: next },
            updatedAt: new Date().toISOString(),
        },
    });
    return [];
}

function remainingBudget(run, name) {
    const limit = Number(run.budget?.limits?.[name] || 0);
    const used = Number(run.budget?.usage?.[name] || 0);
    return limit > 0 ? Math.max(1, limit - used) : undefined;
}

function findBudgetExcess(run, { atLimit = false } = {}) {
    const budget = run?.budget;
    if (!budget?.limits || !budget?.usage) return [];
    return Object.entries(budget.limits).flatMap(([name, rawLimit]) => {
        const limit = Number(rawLimit);
        const used = Number(budget.usage[name] || 0);
        const exceeded = atLimit ? used >= limit : used > limit;
        return limit > 0 && exceeded
            ? [`Courseware run budget ${atLimit ? 'exhausted' : 'exceeded'}: ${name} ${used}/${limit}`]
            : [];
    });
}

function budgetExceededNames(budget) {
    if (!budget?.limits || !budget?.usage) return [];
    return Object.keys(budget.limits).filter((name) => (
        Number(budget.usage[name] || 0) >= Number(budget.limits[name] || 0)
    ));
}

function blockForBudget(projectPath, phaseId, blockers) {
    const run = requireRun(projectPath);
    const normalized = blockers.map(String);
    updateCoursewareAgentRunState(projectPath, {
        status: 'blocked',
        currentPhase: phaseId,
        degraded: run.generationMode === 'automatic-draft' ? true : run.degraded,
        degradedReason: run.generationMode === 'automatic-draft' ? normalized.join('; ') : run.degradedReason,
        budget: {
            status: 'exceeded',
            exceeded: budgetExceededNames(run.budget),
            updatedAt: new Date().toISOString(),
        },
        phaseUpdates: {
            [phaseId]: { status: 'blocked', blockers: normalized, completedAt: new Date().toISOString() },
        },
        publish: { allowed: false, reason: 'Courseware run budget was exhausted; teacher review is required.' },
    });
    return summarize(projectPath);
}

function attachBudgetToRoleReport(projectPath, runId, role) {
    const reportPath = path.join(projectPath, 'reports', runId, `${role}.json`);
    const report = readJson(reportPath);
    if (!report) return;
    const run = requireRun(projectPath, runId);
    writeCoursewareRunReport(projectPath, runId, role, {
        ...report,
        budgetUsage: run.budget?.usage || null,
        budgetLimits: run.budget?.limits || null,
        budgetStatus: run.budget?.status || 'unknown',
    });
}

function nonNegativeNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function summarize(projectPath, extra = {}) {
    return { ...summarizeCoursewareAgentRun(requireRun(projectPath), projectPath), ...extra };
}

function requireRun(projectPath, expectedRunId = null) {
    const run = readCoursewareAgentRun(projectPath);
    if (!run) throw new Error(`Missing agent-run.json in ${projectPath}`);
    if (expectedRunId && run.runId !== expectedRunId) throw new Error(`Run ID mismatch: expected ${expectedRunId}, found ${run.runId}`);
    return run;
}

function blockedDependencies(run, phaseId) {
    const dependencies = [...(PHASE_DEPENDENCIES[phaseId] || [])];
    if (phaseId === 'review' && requestsVideo(run.outputTargets)) dependencies.push('video');
    return dependencies.flatMap((dependencyId) => {
        const dependency = getCoursewarePhase(run, dependencyId);
        return dependency?.status === 'ready' ? [] : [`${phaseId} requires ${dependencyId}=ready (found ${dependency?.status || 'missing'})`];
    });
}

function descendantPhases(phaseId) {
    const result = new Set();
    const visit = (parent) => {
        for (const [candidate, dependencies] of Object.entries(PHASE_DEPENDENCIES)) {
            if (dependencies.includes(parent) && !result.has(candidate)) {
                result.add(candidate);
                visit(candidate);
            }
        }
    };
    visit(phaseId);
    return [...result];
}

function failedSlideIds(report) {
    return (report?.slides || []).filter((slide) => slide.status === 'fail' || slide.revisionRequired).map((slide) => String(slide.slideId));
}

function normalizeValidationBlockers(validation) {
    const items = validation?.issues || validation?.errors || [];
    return items.map((item) => String(item?.message || item?.detail || item));
}

function isReady(result) {
    return result?.status === 'ready';
}

function fileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
