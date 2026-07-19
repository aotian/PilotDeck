import fs from 'node:fs';
import path from 'node:path';

export const COURSEWARE_PHASE_DEFINITIONS = Object.freeze([
    { id: 'requirement', owner: 'courseware-requirement', required: true },
    { id: 'outline', owner: 'courseware-outline', required: true },
    { id: 'script', owner: 'courseware-script', required: true },
    { id: 'exercise', owner: 'courseware-exercise', required: true },
    { id: 'deck', owner: 'courseware-deck', required: true },
    { id: 'video', owner: 'courseware-video', required: true },
    { id: 'review', owner: 'courseware-review', required: true },
    { id: 'teacher-approval', owner: 'teacher', required: true },
    { id: 'publish', owner: 'tiku', required: false },
]);

export const COURSEWARE_AGENT_ROLES = Object.freeze(
    COURSEWARE_PHASE_DEFINITIONS
        .filter((phase) => phase.owner.startsWith('courseware-'))
        .map((phase) => phase.owner),
);

export const COURSEWARE_BUDGET_DEFAULTS = Object.freeze({
    'automatic-draft': Object.freeze({
        inputTokens: 350_000,
        outputTokens: 80_000,
        modelCalls: 32,
        resumes: 4,
        revisions: 12,
    }),
    'high-quality': Object.freeze({
        inputTokens: 700_000,
        outputTokens: 160_000,
        modelCalls: 56,
        resumes: 6,
        revisions: 24,
    }),
});

const VALID_RUN_STATUSES = new Set([
    'requested',
    'running',
    'blocked',
    'failed',
    'awaiting-style-approval',
    'awaiting-teacher-approval',
    'draft',
    'ready',
    'cancelled',
]);

const VALID_PHASE_STATUSES = new Set([
    'pending',
    'running',
    'ready',
    'blocked',
    'failed',
    'skipped',
]);

export function readCoursewareAgentRun(projectPath) {
    const filePath = path.join(projectPath, 'agent-run.json');
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function atomicWriteJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
    return payload;
}

export function createInitialCoursewareAgentRun({
    runId,
    operationMode,
    generationMode = 'automatic-draft',
    target,
    coordinatorSessionId = null,
    teacherApprovedStyleId = null,
    patchScope = null,
    allowedWrites = [],
    outputTargets = ['html', 'pptx'],
    audience = 'student',
    budgetLimits = null,
    now = new Date().toISOString(),
}) {
    const normalizedOutputTargets = normalizeOutputTargets(outputTargets);
    const limits = normalizeCoursewareBudgetLimits(generationMode, budgetLimits);
    return {
        schemaVersion: 'tongcheng.coursewareAgentRun.v2',
        runId,
        createdAt: now,
        updatedAt: now,
        status: 'requested',
        currentPhase: 'requirement',
        operationMode,
        generationMode,
        engine: 'pilotdeck',
        outputTargets: normalizedOutputTargets,
        audience: audience === 'teacher' ? 'teacher' : 'student',
        coordinatorSessionId,
        target,
        phases: COURSEWARE_PHASE_DEFINITIONS.map((phase) => ({
            ...phase,
            required: phase.id === 'video' ? requestsVideo(normalizedOutputTargets) : phase.required,
            status: 'pending',
            startedAt: null,
            completedAt: null,
            reportPath: phase.owner.startsWith('courseware-')
                ? `reports/${runId}/${phase.owner}.json`
                : null,
            blockers: [],
            attempts: 0,
        })),
        style: {
            approvalRequired: generationMode === 'high-quality',
            teacherApprovedStyleId,
            approvedStylePath: teacherApprovedStyleId ? 'approved-style.json' : null,
            previewPaths: [],
        },
        visualQuality: {
            status: 'pending',
            reportPath: null,
            failedSlideIds: [],
            revisedSlideIds: [],
        },
        patch: {
            patchScope,
            allowedWrites,
            targetSlideIds: [],
            history: [],
        },
        budget: {
            status: 'within-budget',
            limits,
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                modelCalls: 0,
                resumes: 0,
                revisions: 0,
            },
            exceeded: [],
            updatedAt: now,
        },
        degraded: false,
        degradedReason: null,
        publish: {
            allowed: false,
            reason: 'Teacher approval and Tiku canonical publish are required.',
        },
    };
}

export function writeCoursewareAgentRun(projectPath, run) {
    validateCoursewareAgentRun(run);
    return atomicWriteJson(path.join(projectPath, 'agent-run.json'), run);
}

export function updateCoursewareAgentRunState(projectPath, patch = {}) {
    const current = readCoursewareAgentRun(projectPath);
    if (!current) throw new Error(`agent-run.json does not exist in ${projectPath}`);

    const phaseUpdates = patch.phaseUpdates && typeof patch.phaseUpdates === 'object'
        ? patch.phaseUpdates
        : {};
    const phases = current.phases.map((phase) => {
        const update = phaseUpdates[phase.id];
        return update ? { ...phase, ...update } : phase;
    });
    const next = {
        ...current,
        ...patch,
        phases,
        style: patch.style ? { ...current.style, ...patch.style } : current.style,
        visualQuality: patch.visualQuality
            ? { ...current.visualQuality, ...patch.visualQuality }
            : current.visualQuality,
        patch: patch.patch ? { ...current.patch, ...patch.patch } : current.patch,
        budget: patch.budget
            ? {
                ...current.budget,
                ...patch.budget,
                limits: patch.budget.limits
                    ? { ...current.budget?.limits, ...patch.budget.limits }
                    : current.budget?.limits,
                usage: patch.budget.usage
                    ? { ...current.budget?.usage, ...patch.budget.usage }
                    : current.budget?.usage,
            }
            : current.budget,
        publish: patch.publish ? { ...current.publish, ...patch.publish } : current.publish,
        updatedAt: new Date().toISOString(),
    };
    delete next.phaseUpdates;
    return writeCoursewareAgentRun(projectPath, next);
}

export function getCoursewarePhase(run, phaseId) {
    return run?.phases?.find((phase) => phase.id === phaseId) || null;
}

export function summarizeCoursewareAgentRun(run, workspacePath = null) {
    const phases = Array.isArray(run?.phases) ? run.phases : [];
    const agentPhases = phases.filter((phase) => String(phase.owner || '').startsWith('courseware-'));
    const byStatus = (status) => agentPhases
        .filter((phase) => phase.status === status)
        .map((phase) => phase.owner);
    const reportPaths = Object.fromEntries(
        agentPhases
            .filter((phase) => phase.reportPath)
            .map((phase) => [phase.owner, phase.reportPath]),
    );

    return {
        runId: run?.runId || null,
        coordinatorSessionId: run?.coordinatorSessionId || null,
        currentPhase: run?.currentPhase || null,
        status: run?.status || 'requested',
        completedAgents: byStatus('ready'),
        runningAgents: byStatus('running'),
        blockedAgents: [...byStatus('blocked'), ...byStatus('failed')],
        blockers: [...new Set(agentPhases.flatMap((phase) => phase.blockers || []).map(String))],
        reportPaths,
        operationMode: run?.operationMode || null,
        generationMode: run?.generationMode || 'automatic-draft',
        engine: run?.engine || 'pilotdeck',
        degraded: Boolean(run?.degraded),
        degradedReason: run?.degradedReason || null,
        styleApprovalRequired: Boolean(run?.style?.approvalRequired),
        awaitingStyleApproval: run?.status === 'awaiting-style-approval',
        teacherApprovedStyleId: run?.style?.teacherApprovedStyleId || null,
        visualQualityStatus: run?.visualQuality?.status || 'pending',
        awaitingTeacherApproval: run?.status === 'awaiting-teacher-approval',
        outputTargets: normalizeOutputTargets(run?.outputTargets),
        audience: run?.audience === 'teacher' ? 'teacher' : 'student',
        budget: run?.budget || null,
        budgetUsage: run?.budget?.usage || null,
        budgetLimits: run?.budget?.limits || null,
        budgetStatus: run?.budget?.status || 'unknown',
        workspacePath,
    };
}

export function normalizeCoursewareBudgetLimits(generationMode, overrides = null) {
    const defaults = COURSEWARE_BUDGET_DEFAULTS[generationMode] || COURSEWARE_BUDGET_DEFAULTS['automatic-draft'];
    const source = overrides && typeof overrides === 'object' ? overrides : {};
    return Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => {
        const value = Number(source[name]);
        return [name, Number.isSafeInteger(value) && value > 0 ? value : fallback];
    }));
}

export function normalizeOutputTargets(value) {
    const targets = Array.isArray(value) ? value : [];
    const normalized = [...new Set(targets.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
    return normalized.length ? normalized : ['html', 'pptx'];
}

export function requestsVideo(outputTargets) {
    return normalizeOutputTargets(outputTargets).some((target) => ['video', 'video-script', 'mp4'].includes(target));
}

function validateCoursewareAgentRun(run) {
    if (!run || typeof run !== 'object') throw new Error('agent run must be an object');
    if (!run.runId) throw new Error('agent run requires runId');
    if (!VALID_RUN_STATUSES.has(run.status)) throw new Error(`invalid agent run status: ${run.status}`);
    const ids = new Set();
    for (const phase of run.phases || []) {
        if (ids.has(phase.id)) throw new Error(`duplicate agent run phase: ${phase.id}`);
        ids.add(phase.id);
        if (!VALID_PHASE_STATUSES.has(phase.status)) {
            throw new Error(`invalid phase status for ${phase.id}: ${phase.status}`);
        }
    }
    for (const definition of COURSEWARE_PHASE_DEFINITIONS) {
        if (!ids.has(definition.id)) throw new Error(`missing agent run phase: ${definition.id}`);
    }
}
