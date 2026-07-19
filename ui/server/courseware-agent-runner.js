import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runChatViaGateway } from './pilotdeck-bridge.js';
import { writeCoursewareRunReport } from './courseware-run-policy.js';

export const COURSEWARE_ROLE_SPECS = Object.freeze({
    requirement: {
        subagentType: 'courseware-requirement',
        inputs: ['teacher-request.md', 'tiku-context.json', 'asset-request.json', 'source-lock.json'],
        requiredOutputs: ['brief.md'],
        optionalOutputs: [],
        nextAgent: 'courseware-outline',
    },
    outline: {
        subagentType: 'courseware-outline',
        inputs: ['brief.md', 'tiku-context.json'],
        requiredOutputs: ['course-outline.md', 'pitfalls.md'],
        optionalOutputs: [],
        nextAgent: 'courseware-script,courseware-exercise',
    },
    script: {
        subagentType: 'courseware-script',
        inputs: ['brief.md', 'course-outline.md', 'pitfalls.md'],
        requiredOutputs: ['teacher-script.md'],
        optionalOutputs: [],
        nextAgent: 'courseware-deck',
    },
    exercise: {
        subagentType: 'courseware-exercise',
        inputs: ['brief.md', 'course-outline.md', 'tiku-context.json'],
        requiredOutputs: ['exercises.md'],
        optionalOutputs: ['homework.md', 'oj-exercises.md', 'edu-exercises.md'],
        nextAgent: 'courseware-deck',
    },
    deck: {
        subagentType: 'courseware-deck',
        inputs: [
            'brief.md',
            'course-outline.md',
            'pitfalls.md',
            'teacher-script.md',
            'exercises.md',
            'tiku-context.json',
        ],
        requiredOutputs: ['design-brief.json', 'deck-plan.md', 'courseware-slides.json'],
        optionalOutputs: [],
        nextAgent: 'courseware-video',
    },
    video: {
        subagentType: 'courseware-video',
        inputs: ['brief.md', 'course-outline.md', 'teacher-script.md', 'courseware-slides.json'],
        requiredOutputs: ['video-script.md'],
        optionalOutputs: [],
        nextAgent: 'courseware-review',
    },
    review: {
        subagentType: 'courseware-review',
        inputs: [
            'brief.md',
            'course-outline.md',
            'pitfalls.md',
            'teacher-script.md',
            'exercises.md',
            'courseware-slides.json',
            'video-script.md',
            'tiku-context.json',
            'asset-request.json',
            'source-lock.json',
            'agent-run.json',
            'visual-quality-report.json',
        ],
        requiredOutputs: ['courseware-package.json', 'generator-handoff.json'],
        optionalOutputs: [],
        nextAgent: 'teacher-approval',
    },
});

const STYLE_IDS = ['style-a', 'style-b', 'style-c'];
const STYLE_PAGE_TYPES = ['cover', 'concept', 'example', 'practice'];

export function createGatewayCoursewareAgentRunner(options = {}) {
    const invoke = options.runChat || runChatViaGateway;
    const defaultModel = options.model || process.env.TONGCHENG_COURSEWARE_AGENT_MODEL || 'tc-admin/tc-main';
    const repoRoot = options.repoRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

    return {
        async run(request) {
            const spec = COURSEWARE_ROLE_SPECS[request.phase];
            if (!spec) throw new Error(`Unknown courseware agent phase: ${request.phase}`);
            if (request.subagentType && request.subagentType !== spec.subagentType) {
                throw new Error(`Phase ${request.phase} requires ${spec.subagentType}, received ${request.subagentType}`);
            }

            const projectPath = path.resolve(request.projectPath);
            const action = request.action || 'produce';
            const model = request.model || defaultModel;
            const requestedMaxOutputTokens = Number(request.maxOutputTokens || 0);
            const minimumOutputTokens = request.phase === 'deck'
                ? action === 'style-preview'
                    ? 60000
                    : action === 'repair'
                        ? 40000
                        : 80000
                : 20000;
            const maxOutputTokens = Math.max(
                Number.isFinite(requestedMaxOutputTokens) ? requestedMaxOutputTokens : 0,
                minimumOutputTokens,
            );
            const hardMaxOutputTokens = Number(request.hardMaxOutputTokens || 0);
            const boundedMaxOutputTokens = Number.isSafeInteger(hardMaxOutputTokens) && hardMaxOutputTokens > 0
                ? Math.min(maxOutputTokens, hardMaxOutputTokens)
                : maxOutputTokens;
            const requiredInputs = resolveRequiredInputs(spec, request);
            const missingInputs = requiredInputs.filter((fileName) => !fs.existsSync(path.join(projectPath, fileName)));
            if (missingInputs.length) {
                return blockedResult(request, spec, model, `Missing required inputs: ${missingInputs.join(', ')}`);
            }

            const outputContract = resolveOutputContract(spec, request);
            const outputIssuesBeforeRun = outputContract.required
                .map((fileName) => ({ fileName, issue: requiredOutputIssue(projectPath, fileName) }))
                .filter((entry) => entry.issue);
            const missingOutputsBeforeRun = outputIssuesBeforeRun.map((entry) => entry.fileName);
            const stagingReport = path.join('reports', request.runId, '.staging', `${spec.subagentType}-${action}.json`);
            const before = fingerprintWorkspace(projectPath);
            const existingArchivedReport = readJsonIfExists(
                path.join(projectPath, 'reports', request.runId, `${spec.subagentType}.json`),
            );
            // Each deterministic delegation gets a fresh parent session. Reusing the
            // coordinator chat across roles lets prior completion messages bias a
            // later turn into claiming success without issuing the Agent tool call.
            const sessionKey = request.sessionId || `web:s_${crypto.randomUUID()}`;
            const frames = [];
            const gatewayEvents = [];
            const writer = { send: (frame) => frames.push(frame) };
            const prompt = buildCoordinatorPrompt({
                repoRoot,
                projectPath,
                request,
                spec,
                action,
                stagingReport,
                requiredInputs,
                outputContract,
                missingOutputsBeforeRun,
                outputIssuesBeforeRun,
            });
            const startedAt = new Date().toISOString();

            await invoke(prompt, {
                sessionKey,
                sessionId: sessionKey,
                projectPath,
                cwd: projectPath,
                workspaceCwd: projectPath,
                permissionMode: 'bypassPermissions',
                model,
                maxOutputTokens: boundedMaxOutputTokens,
                onGatewayEvent: (event) => gatewayEvents.push(sanitizeDiagnosticValue(event)),
                stopWhenGatewayEvent: (event) => isSuccessfulSubagentCompletion(event, spec.subagentType),
            }, writer, 'pilotdeck');

            const completedAt = new Date().toISOString();
            const evidence = collectLifecycleEvidence(frames, spec.subagentType);
            const usage = normalizeUsage(evidence.usage);
            const modelCalls = Math.max(1, Number(evidence.turns || 0) + 1);
            if (evidence.completed) {
                await waitForRequiredOutputs(projectPath, outputContract.required);
            }
            const lifecycleSubagentIds = [...new Set(evidence.events.map((event) => event.subagentId).filter(Boolean))];
            const agentToolCallCount = countAgentToolCalls(gatewayEvents);
            const errorFrame = frames.find((frame) => frame?.kind === 'error' || frame?.type === 'error');
            const after = fingerprintWorkspace(projectPath);
            const changedFiles = listChangedFiles(before, after);
            const coordinatorManagedWrites = normalizeWriteList(request.coordinatorManagedWrites);
            const concurrentAllowedWrites = normalizeWriteList(request.concurrentAllowedWrites);
            const coordinatorWritesObserved = changedFiles.filter((fileName) => coordinatorManagedWrites.includes(fileName));
            const concurrentWritesObserved = [...new Set(changedFiles.filter((fileName) => (
                (
                    concurrentAllowedWrites.includes(fileName)
                    || isConcurrentRoleReportWrite(fileName, request.runId, spec.subagentType, stagingReport)
                ) && !coordinatorManagedWrites.includes(fileName)
            )))];
            const externallyManagedWrites = new Set([...coordinatorWritesObserved, ...concurrentWritesObserved]);
            const stagedReportPath = path.join(projectPath, stagingReport);
            const stagedReportChanged = before.get(stagingReport) !== after.get(stagingReport);
            const rootReportChanged = before.get('courseware-agent-report.json') !== after.get('courseware-agent-report.json');
            // Reports left by a previous failed attempt are historical evidence,
            // not authoritative status for this invocation. Only consume a role
            // report when the current subagent actually refreshed it.
            const agentReport = (stagedReportChanged ? readJsonIfExists(stagedReportPath) : null)
                || (rootReportChanged ? readCompatibleRootReport(projectPath, spec.subagentType) : null)
                || {};
            const invalidOutputs = outputContract.required
                .map((fileName) => ({ fileName, issue: requiredOutputIssue(projectPath, fileName) }))
                .filter((entry) => entry.issue);
            const forbiddenWrites = (outputContract.forbidden || []).filter((fileName) => before.get(fileName) !== after.get(fileName));
            const unexpectedWrites = changedFiles.filter((fileName) => !isAllowedWrite(
                fileName,
                outputContract,
                stagingReport,
                concurrentAllowedWrites,
                coordinatorManagedWrites,
            ));
            const noEffectiveRepair = action === 'repair'
                && before.get('courseware-slides.json') === after.get('courseware-slides.json');
            const blockers = [
                ...(Array.isArray(agentReport.blockers) ? agentReport.blockers.map(String) : []),
                ...(errorFrame ? [String(errorFrame.content || errorFrame.text || 'Gateway agent error')] : []),
                ...(!evidence.started ? [`No subagent_started evidence for ${spec.subagentType}`] : []),
                ...(!evidence.completed ? [`No successful subagent_completed evidence for ${spec.subagentType}`] : []),
                ...(lifecycleSubagentIds.length > 1 ? [`Expected exactly one ${spec.subagentType} subagent, observed ${lifecycleSubagentIds.length}`] : []),
                ...(gatewayEvents.length && agentToolCallCount !== 1 ? [`Expected exactly one Agent tool call, observed ${agentToolCallCount}`] : []),
                ...(invalidOutputs.length ? [`Missing or invalid required outputs: ${invalidOutputs.map((entry) => `${entry.fileName} (${entry.issue})`).join(', ')}`] : []),
                ...(forbiddenWrites.length ? [`Forbidden outputs changed: ${forbiddenWrites.join(', ')}`] : []),
                ...(unexpectedWrites.length ? [`Writes outside role contract: ${unexpectedWrites.join(', ')}`] : []),
                ...(noEffectiveRepair ? ['Deck repair made no effective change to courseware-slides.json'] : []),
            ];
            const diagnosticPath = writeGatewayDiagnostic({
                projectPath,
                runId: request.runId,
                subagentType: spec.subagentType,
                action,
                sessionKey,
                prompt,
                gatewayEvents,
                frames,
                blockers,
            });
            const reportedStatus = String(agentReport.status || '').toLowerCase();
            const status = blockers.length
                ? (reportedStatus === 'blocked' ? 'blocked' : 'failed')
                : reportedStatus === 'blocked'
                    ? 'blocked'
                    : 'ready';
            const report = {
                schemaVersion: 'tongcheng.coursewareAgentReport.v1',
                runId: request.runId,
                agentRole: spec.subagentType,
                subagentType: spec.subagentType,
                lessonId: request.lessonId || agentReport.lessonId || null,
                status,
                startedAt,
                completedAt,
                inputsRead: normalizeStringArray(agentReport.inputsRead, requiredInputs),
                filesWritten: changedFiles.filter((fileName) => (
                    fileName !== stagingReport && !externallyManagedWrites.has(fileName)
                )),
                coordinatorWritesObserved,
                concurrentWritesObserved,
                nextAgent: spec.nextAgent,
                blockers,
                checks: [
                    { name: 'subagent-started', status: evidence.started ? 'pass' : 'fail', detail: evidence.subagentId || 'missing' },
                    { name: 'subagent-completed', status: evidence.completed ? 'pass' : 'fail', detail: evidence.completed ? 'success' : 'missing or failed' },
                    { name: 'required-outputs', status: invalidOutputs.length ? 'fail' : 'pass', detail: invalidOutputs.map((entry) => `${entry.fileName}: ${entry.issue}`).join(', ') || 'present and valid' },
                    { name: 'write-scope', status: unexpectedWrites.length ? 'fail' : 'pass', detail: unexpectedWrites.join(', ') || 'within role contract' },
                    {
                        name: 'coordinator-write-isolation',
                        status: 'pass',
                        detail: coordinatorWritesObserved.length
                            ? `Observed but not attributed to this role: ${coordinatorWritesObserved.join(', ')}`
                            : 'No concurrent coordinator writes observed',
                    },
                    ...(Array.isArray(agentReport.checks) ? agentReport.checks : []),
                ],
                model,
                sessionId: sessionKey,
                subagentId: evidence.subagentId,
                lifecycleEvents: evidence.events,
                agentToolCallCount: gatewayEvents.length ? agentToolCallCount : null,
                usage,
                modelCalls,
                gatewayDiagnosticPath: diagnosticPath,
                action,
                invocations: [
                    ...(Array.isArray(existingArchivedReport?.invocations) ? existingArchivedReport.invocations : []),
                    {
                        action,
                        subagentType: spec.subagentType,
                        subagentId: evidence.subagentId,
                        sessionId: sessionKey,
                        startedAt,
                        completedAt,
                        status,
                        usage,
                        modelCalls,
                    },
                ],
            };
            const reportPath = writeCoursewareRunReport(projectPath, request.runId, spec.subagentType, report);
            fs.writeFileSync(path.join(projectPath, 'courseware-agent-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

            return {
                ...report,
                reportPath: path.relative(projectPath, reportPath),
                coordinatorSessionId: request.coordinatorSessionId || sessionKey,
            };
        },
    };
}

function resolveRequiredInputs(spec, request) {
    if (request.phase === 'review' && !requestsVideo(request.outputTargets)) {
        return spec.inputs.filter((fileName) => fileName !== 'video-script.md');
    }
    if (request.phase !== 'deck') return spec.inputs;
    if (request.action === 'style-preview') return spec.inputs;
    if (request.action === 'repair') return [...spec.inputs, 'courseware-slides.json', 'approved-style.json', 'visual-quality-report.json'];
    if (request.generationMode === 'high-quality') return [...spec.inputs, 'approved-style.json'];
    return spec.inputs;
}

function resolveOutputContract(spec, request) {
    if (request.phase !== 'deck') {
        return { required: spec.requiredOutputs, optional: spec.optionalOutputs, prefixes: [] };
    }
    if (request.action === 'style-preview') {
        return {
            required: [
                'design-brief.json',
                'deck-plan.md',
                ...STYLE_IDS.flatMap((styleId) => [
                    `style-previews/${styleId}/style.json`,
                    ...STYLE_PAGE_TYPES.map((pageType) => `style-previews/${styleId}/${pageType}.html`),
                ]),
            ],
            optional: [],
            prefixes: ['style-previews/'],
            forbidden: ['courseware-slides.json'],
        };
    }
    if (request.action === 'repair') {
        return {
            required: ['courseware-slides.json'],
            optional: [],
            prefixes: [],
        };
    }
    return {
        required: spec.requiredOutputs,
        optional: spec.optionalOutputs,
        prefixes: [],
    };
}

function buildCoordinatorPrompt({ repoRoot, projectPath, request, spec, action, stagingReport, requiredInputs, outputContract, missingOutputsBeforeRun, outputIssuesBeforeRun }) {
    const targetSlideIds = Array.isArray(request.targetSlideIds) ? request.targetSlideIds : [];
    const deckRecoveryDirective = request.phase === 'deck' && action === 'produce'
        ? buildDeckRecoveryDirective(projectPath, outputIssuesBeforeRun)
        : '';
    const visualRepairDirective = request.phase === 'deck' && action === 'repair'
        ? buildVisualRepairDirective(projectPath, targetSlideIds)
        : '';
    const roleDirective = [
        `Run ID: ${request.runId}`,
        `Lesson workspace: ${projectPath}`,
        `Operation mode: ${request.operationMode}`,
        `Generation mode: ${request.generationMode}`,
        `Audience: ${request.audience === 'teacher' ? 'teacher' : 'student'}`,
        `Output targets: ${Array.isArray(request.outputTargets) ? request.outputTargets.join(', ') : 'html, pptx'}`,
        `Role action: ${action}`,
        `Read only these assigned inputs: ${requiredInputs.join(', ')}`,
        `Required outputs: ${outputContract.required.join(', ')}`,
        `Outputs missing or invalid at invocation start (write exactly these before reporting): ${missingOutputsBeforeRun.join(', ') || 'none'}`,
        outputIssuesBeforeRun.length
            ? `Exact validation failures at invocation start:\n- ${outputIssuesBeforeRun.map((entry) => `${entry.fileName}: ${entry.issue}`).join('\n- ')}`
            : '',
        missingOutputsBeforeRun.length < outputContract.required.length
            ? 'Existing valid required outputs do not need to be rewritten; preserve them and complete the missing list.'
            : '',
        `Optional outputs: ${outputContract.optional.join(', ') || 'none'}`,
        Array.isArray(request.previousBlockers) && request.previousBlockers.length
            ? `This is a retry. Fix these previously reported blockers before declaring completion:\n- ${request.previousBlockers.map(String).join('\n- ')}\nA required output named in these blockers is not an accepted asset. You are authorized to replace that invalid output within this role's declared write contract; do not treat mere file existence as completion.`
            : '',
        `Write the independent role report to ${stagingReport} and also refresh courseware-agent-report.json for compatibility.`,
        'Do not publish, call production APIs, bind courses/classes/students/exams/knowledge points, or write outside this lesson workspace.',
        'Do not let teacher-script.md or operational instructions enter student-visible slide HTML.',
        request.phase === 'exercise'
            ? 'Use real Tiku questions first and preserve question_id, knowledge_id, difficulty, answer, analysis, and source. Mark AI additions as ai-draft.'
            : '',
        request.phase === 'deck' && action === 'style-preview'
            ? [
                'Create design-brief.json and three structurally different style directions. Each style.json must contain the exact styleId (style-a/style-b/style-c), name, designRationale, suitableClassroom, strengths, risks, designTokens, informationHierarchy, layoutFamilies, diagramMode, codeVisualMode, interactionPattern, and illustrationMode.',
                'The three informationHierarchy/layoutFamilies/diagramMode/codeVisualMode/interactionPattern/illustrationMode combinations must differ structurally, not only by color. Each style also needs cover.html, concept.html, example.html, and practice.html.',
                'Persist previews one style at a time. Do not batch or merely describe writes: invoke write_file or edit_file for every missing file, then use bash test -s on all five files for that style before moving to the next style.',
                'Before the final report, run test -s for every required preview path and continue writing while any path is missing. Never claim a preview exists unless the filesystem check succeeds.',
                'Do not create courseware-slides.json before teacher style approval.',
            ].join(' ')
            : '',
        request.phase === 'deck' && action === 'produce' && request.generationMode === 'high-quality'
            ? [
                'Read approved-style.json and use its exact tokens and layout system. Do not choose or randomize another style.',
                'This is initial full-deck creation, not an incremental patch: create every slide required by deck-plan.md in one valid courseware-slides.json during this invocation.',
                deckRecoveryDirective,
                'You must invoke write_file or edit_file for each missing required output. Reading inputs or describing intended writes is not completion.',
                'Do not write the complete deck in one large write_file call because tool arguments can be truncated. First write a valid JSON skeleton with slides containing exactly {"id":"__PILOTDECK_SLIDE_SENTINEL__"}. Then append only 1-2 complete slides per edit_file call by replacing that sentinel object with the new slide objects followed by the same sentinel. After all planned slides are present, remove the sentinel, verify slide count/order, and JSON.parse the final file.',
                'Before the final report, verify every required path exists and run a real JSON.parse check for each required JSON output. Never claim a file was written unless that check succeeds.',
            ].join(' ')
            : '',
        request.phase === 'deck' && action === 'produce'
            ? 'When tiku-context.json contains questions, at least one student-visible slide must include question_refs. Each non-ai-draft reference must preserve a question_id from that exact context; never invent or silently drop Tiku IDs.'
            : '',
        request.phase === 'deck' && action === 'repair'
            ? [
                `Patch only these slide IDs: ${targetSlideIds.join(', ')}. Preserve every unrelated slide byte-for-byte in meaning and structure.`,
                visualRepairDirective,
                'The exact Chrome failures are embedded above. Do not list the workspace and do not call read_file on visual-quality-report.json or unrelated inputs.',
                'Your first subagent tool call must be edit_file mutating courseware-slides.json for the assigned target. Do not spend an initial turn narrating or inspecting the whole deck.',
                'For the slide mutation, use edit_file directly. Bash, Node, Python, generated helper scripts, HTML dumps, and debug files are forbidden. courseware-slides.json and the assigned reports are the only permitted writes.',
                'Use measured fixes: raise all target text below 18px to at least 18px and code below 20px to at least 20px; replace low-contrast foreground/background pairs while retaining approved style tokens; reduce target-only padding, gaps, or duplicated detail where text is clipped or rootOverflow is true.',
                'You must make an effective edit_file change to courseware-slides.json before reporting. A no-op repair is a failed run.',
                'Re-parse courseware-slides.json after the edit and verify every target slide still exists.',
            ].join(' ')
            : '',
        request.phase === 'review'
            ? [
                'Before any optional audit or shell command, create the missing required JSON outputs with direct write_file calls.',
                'Your first subagent tool call must be write_file for courseware-package.json and your second subagent tool call must be write_file for generator-handoff.json. Each file must be valid, non-empty JSON grounded in the assigned inputs; use status draft or ready-for-teacher-review and publish.allowed=false.',
                'Do not use Bash, Node, Python, a heredoc, or a generated helper script to create either required JSON file. A failed tool call does not satisfy the output contract: retry the direct write_file call and verify both files exist before completing.',
                `After both required files exist, run the shared validator with: node ${path.join(repoRoot, 'scripts/validate-courseware-workspace.mjs')} --workspace ${projectPath}.`,
                'Review must finish last and may only report blocked, draft, awaiting-teacher-approval, or ready-for-teacher-review; it must not publish.',
            ].join(' ')
            : '',
    ].filter(Boolean).join('\n');
    const toolInput = {
        description: `${spec.subagentType} ${action}`,
        prompt: roleDirective,
        subagent_type: spec.subagentType,
    };
    return [
        'You are the deterministic Courseware Coordinator executor.',
        'Do not perform the assigned role yourself and do not use any tool other than Agent.',
        'Call the Agent tool exactly once with the JSON input below. The subagent_type value is mandatory and must be unchanged.',
        JSON.stringify(toolInput, null, 2),
        'After the Agent tool returns, do not edit files. Return one short sentence confirming the delegated lifecycle ended.',
    ].join('\n\n');
}

function buildDeckRecoveryDirective(projectPath, outputIssues) {
    const slidesIssue = outputIssues.find((entry) => entry.fileName === 'courseware-slides.json')?.issue;
    if (slidesIssue !== 'contains unfinished slide sentinel') return '';
    const slides = readJsonIfExists(path.join(projectPath, 'courseware-slides.json'))?.slides || [];
    const completedSlideIds = slides
        .map((slide) => String(slide?.id || ''))
        .filter((id) => id && id !== '__PILOTDECK_SLIDE_SENTINEL__');
    return [
        `Recovery checkpoint: courseware-slides.json already has ${completedSlideIds.length} complete slides (${completedSlideIds.join(', ')}) followed by __PILOTDECK_SLIDE_SENTINEL__.`,
        'Preserve those completed slides. Do not write a new skeleton and do not regenerate them.',
        'Your first mutating tool call must be edit_file on courseware-slides.json replacing the existing sentinel with any remaining complete planned slides, or removing it if the plan is already complete.',
        'After that edit, use a real filesystem parse/check proving the sentinel is absent. A narrative claim that the edit happened is a failed run.',
    ].join(' ');
}

function buildVisualRepairDirective(projectPath, targetSlideIds) {
    const report = readJsonIfExists(path.join(projectPath, 'visual-quality-report.json'));
    const slidesPackage = readJsonIfExists(path.join(projectPath, 'courseware-slides.json'));
    const targets = new Set(targetSlideIds.map(String));
    const issueLines = (Array.isArray(report?.slides) ? report.slides : [])
        .filter((slide) => targets.has(String(slide?.slideId || '')))
        .map((slide) => {
            const issues = (Array.isArray(slide?.issues) ? slide.issues : [])
                .map((issue) => `${issue.check}: ${issue.detail}`)
                .join('; ');
            return `${slide.slideId}: ${issues || 'failed visual check'}`;
        });
    const targetSlides = (Array.isArray(slidesPackage?.slides) ? slidesPackage.slides : [])
        .filter((slide) => targets.has(String(slide?.id || '')));
    const sourceDirective = targetSlides.length
        ? `Current target slide objects are provided here so the first tool call can edit without reading the full deck:\n${JSON.stringify(targetSlides, null, 2)}`
        : 'Target slide source is unavailable; report blocked instead of guessing.';
    const issuesDirective = issueLines.length
        ? `Fix these measured Chrome issues, not generic styling:\n- ${issueLines.join('\n- ')}`
        : 'Read visual-quality-report.json and fix the measured Chrome issues for every target slide.';
    return `${issuesDirective}\n${sourceDirective}`;
}

function collectLifecycleEvidence(frames, expectedType) {
    const events = frames
        .filter((frame) => frame?.kind === 'agent_activity' && frame?.phase === 'subagent')
        .filter((frame) => !frame.subagentType || frame.subagentType === expectedType)
        .map((frame) => ({
            state: frame.state,
            subagentType: frame.subagentType || expectedType,
            subagentId: frame.subagentId || String(frame.activityId || '').replace(/^subagent:/, ''),
            startedAt: frame.startedAt || null,
            completedAt: frame.endedAt || null,
            durationMs: frame.durationMs ?? null,
            success: frame.subagentSuccess !== false && frame.state !== 'failed',
            usage: frame.subagentUsage || null,
            turns: frame.subagentTurns ?? null,
        }));
    const started = events.find((event) => event.state === 'running');
    const completed = [...events].reverse().find((event) => event.state === 'completed' && event.success);
    return {
        started: Boolean(started),
        completed: Boolean(completed),
        subagentId: completed?.subagentId || started?.subagentId || null,
        usage: completed?.usage || null,
        turns: completed?.turns ?? null,
        events,
    };
}

function isSuccessfulSubagentCompletion(event, expectedType) {
    return event?.type === 'agent_status'
        && event?.event === 'subagent_completed'
        && event?.detail?.subagentType === expectedType
        && event?.detail?.success !== false;
}

function countAgentToolCalls(events) {
    return events.filter((event) => (
        event?.type === 'tool_call_started'
        && String(event?.toolName || event?.name || '').toLowerCase() === 'agent'
    )).length;
}

function writeGatewayDiagnostic({ projectPath, runId, subagentType, action, sessionKey, prompt, gatewayEvents, frames, blockers }) {
    const relativePath = path.posix.join(
        'reports',
        String(runId),
        'diagnostics',
        `${subagentType}-${action}-${crypto.randomUUID().slice(0, 8)}.json`,
    );
    const filePath = path.join(projectPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = {
        schemaVersion: 'tongcheng.coursewareGatewayDiagnostic.v1',
        runId,
        subagentType,
        action,
        sessionId: sessionKey,
        capturedAt: new Date().toISOString(),
        prompt: sanitizeDiagnosticValue(prompt),
        gatewayEvents,
        normalizedFrames: sanitizeDiagnosticValue(frames),
        blockers: blockers.map(String),
    };
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return relativePath;
}

function sanitizeDiagnosticValue(value, key = '') {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
        if (/authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret/i.test(key)) return '[REDACTED]';
        return value.length > 20_000 ? `${value.slice(0, 20_000)}\n[TRUNCATED]` : value;
    }
    if (Array.isArray(value)) return value.slice(0, 500).map((entry) => sanitizeDiagnosticValue(entry, key));
    if (typeof value === 'object') {
        const result = {};
        for (const [entryKey, entryValue] of Object.entries(value)) {
            result[entryKey] = sanitizeDiagnosticValue(entryValue, entryKey);
        }
        return result;
    }
    return String(value);
}

function blockedResult(request, spec, model, blocker) {
    const now = new Date().toISOString();
    const report = {
        schemaVersion: 'tongcheng.coursewareAgentReport.v1',
        runId: request.runId,
        agentRole: spec.subagentType,
        subagentType: spec.subagentType,
        lessonId: request.lessonId || null,
        status: 'blocked',
        startedAt: now,
        completedAt: now,
        inputsRead: [],
        filesWritten: [],
        nextAgent: spec.nextAgent,
        blockers: [blocker],
        checks: [{ name: 'required-inputs', status: 'fail', detail: blocker }],
        model,
        sessionId: null,
        subagentId: null,
        lifecycleEvents: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        modelCalls: 0,
    };
    const reportPath = writeCoursewareRunReport(request.projectPath, request.runId, spec.subagentType, report);
    return { ...report, reportPath: path.relative(request.projectPath, reportPath) };
}

function fingerprintWorkspace(projectPath) {
    const result = new Map();
    walkFiles(projectPath, '', result);
    return result;
}

function walkFiles(rootPath, relativeDir, result) {
    const absoluteDir = path.join(rootPath, relativeDir);
    if (!fs.existsSync(absoluteDir)) return;
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
        const relativePath = path.posix.join(relativeDir.split(path.sep).join('/'), entry.name);
        if (entry.isDirectory()) {
            if (['.git', 'node_modules', '.courseware-runs', 'screenshots'].includes(entry.name)) continue;
            walkFiles(rootPath, relativePath, result);
        } else if (entry.isFile()) {
            const content = fs.readFileSync(path.join(rootPath, relativePath));
            result.set(relativePath, crypto.createHash('sha256').update(content).digest('hex'));
        }
    }
}

function listChangedFiles(before, after) {
    const files = new Set([...before.keys(), ...after.keys()]);
    return [...files].filter((fileName) => before.get(fileName) !== after.get(fileName)).sort();
}

function isAllowedWrite(
    fileName,
    contract,
    stagingReport,
    concurrentAllowedWrites = [],
    coordinatorManagedWrites = [],
) {
    if (fileName === 'courseware-agent-report.json' || fileName === stagingReport) return true;
    if (fileName.startsWith('reports/')) return true;
    if (contract.required.includes(fileName) || contract.optional.includes(fileName)) return true;
    if (concurrentAllowedWrites.includes(fileName) || coordinatorManagedWrites.includes(fileName)) return true;
    return contract.prefixes.some((prefix) => fileName.startsWith(prefix));
}

function requiredOutputIssue(projectPath, fileName) {
    const filePath = path.join(projectPath, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile() || fs.statSync(filePath).size === 0) return 'missing or empty';
    if (fileName.endsWith('.json')) {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            return 'invalid JSON';
        }
        if (fileName === 'courseware-slides.json') return coursewareSlidesIssue(parsed, projectPath);
    }
    return null;
}

function coursewareSlidesIssue(document, projectPath) {
    if (!Array.isArray(document?.slides) || document.slides.length === 0) return 'slides must be a nonempty array';
    if (document.slides.some((slide) => slide?.id === '__PILOTDECK_SLIDE_SENTINEL__')) {
        return 'contains unfinished slide sentinel';
    }
    const ids = document.slides.map((slide) => String(slide?.id || '').trim());
    if (ids.some((id) => !id)) return 'slide id is required';
    if (new Set(ids).size !== ids.length) return 'slide ids must be unique';
    const incompleteSlide = document.slides.find((slide) => (
        !Number.isFinite(Number(slide?.order))
        || !String(slide?.type || '').trim()
        || !String(slide?.title || '').trim()
        || !String(slide?.html || '').trim()
    ));
    if (incompleteSlide) return `slide ${incompleteSlide.id || '(unknown)'} is missing order, type, title, or html`;

    const context = readJsonIfExists(path.join(projectPath, 'tiku-context.json'));
    const questions = Array.isArray(context?.questions) ? context.questions : [];
    if (questions.length === 0) return null;

    const contextQuestionIds = new Set(questions
        .map((question) => String(question?.question_id || question?.questionId || question?.id || '').trim())
        .filter(Boolean));
    const refs = document.slides.flatMap((slide) => {
        const rawRefs = Array.isArray(slide?.question_refs)
            ? slide.question_refs
            : Array.isArray(slide?.questionRefs) ? slide.questionRefs : [];
        return rawRefs.map((ref) => {
            if (typeof ref === 'string' || typeof ref === 'number') {
                return { source: 'tiku', questionId: String(ref).trim() };
            }
            return {
                source: String(ref?.source || 'tiku').trim(),
                questionId: String(ref?.question_id || ref?.questionId || ref?.id || '').trim(),
            };
        });
    });
    if (refs.length === 0) return 'tiku-context contains questions but slides contain no question_refs';
    if (refs.some((ref) => !ref.questionId)) return 'question_refs must include question_id';
    const unknown = refs.find((ref) => ref.source !== 'ai-draft' && contextQuestionIds.size > 0 && !contextQuestionIds.has(ref.questionId));
    return unknown ? `question_ref ${unknown.questionId} is not present in tiku-context.json` : null;
}

async function waitForRequiredOutputs(projectPath, requiredOutputs, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (requiredOutputs.every((fileName) => requiredOutputIssue(projectPath, fileName) === null)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

function readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function readCompatibleRootReport(projectPath, expectedRole) {
    const report = readJsonIfExists(path.join(projectPath, 'courseware-agent-report.json'));
    const role = String(report?.subagentType || report?.agentRole || '');
    return role === expectedRole || role === expectedRole.replace('courseware-', '') ? report : null;
}

function normalizeStringArray(value, fallback) {
    return Array.isArray(value) ? value.map(String) : fallback;
}

function normalizeWriteList(value) {
    return Array.isArray(value) ? [...new Set(value.map(String))] : [];
}

function normalizeUsage(value) {
    const usage = value && typeof value === 'object' ? value : {};
    const inputTokens = Math.max(0, Number(usage.inputTokens || usage.input_tokens || 0));
    const outputTokens = Math.max(0, Number(usage.outputTokens || usage.output_tokens || 0));
    return {
        inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
        outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
        totalTokens: (Number.isFinite(inputTokens) ? inputTokens : 0)
            + (Number.isFinite(outputTokens) ? outputTokens : 0),
    };
}

function requestsVideo(outputTargets) {
    return (Array.isArray(outputTargets) ? outputTargets : [])
        .map((value) => String(value).trim().toLowerCase())
        .some((value) => ['video', 'video-script', 'mp4'].includes(value));
}

function isConcurrentRoleReportWrite(fileName, runId, subagentType, stagingReport) {
    const runPrefix = `reports/${runId}/`;
    if (!fileName.startsWith(runPrefix) || fileName === stagingReport) return false;
    return path.posix.basename(fileName) !== `${subagentType}.json`;
}
