import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    createInitialCoursewareAgentRun,
    updateCoursewareAgentRunState,
    writeCoursewareAgentRun,
} from './courseware-agent-state.js';

export const COURSEWARE_OPERATION_MODES = Object.freeze([
    'audit-only',
    'reuse-existing',
    'new-asset',
    'incremental-update',
    'full-rebuild',
]);

export const COURSEWARE_PRIMARY_FILES = Object.freeze([
    'courseware-slides.json',
    'deck.html',
    'slides-manifest.json',
    'courseware-package.json',
    'generator-handoff.json',
]);

export const COURSEWARE_MUTABLE_FILES = Object.freeze([
    'tiku-context.json',
    'teacher-request.md',
    'brief.md',
    'course-outline.md',
    'teacher-script.md',
    'exercises.md',
    'pitfalls.md',
    'homework.md',
    'oj-exercises.md',
    'edu-exercises.md',
    'video-script.md',
    'design-brief.json',
    'approved-style.json',
    'deck-plan.md',
    'visual-quality-report.json',
    'courseware.pptx',
    'courseware.pdf',
    'pptx-export.json',
    'pdf-export.json',
    ...COURSEWARE_PRIMARY_FILES,
    'courseware-agent-report.json',
    'asset-request.json',
    'source-lock.json',
    'agent-run.json',
]);

export const COURSEWARE_REBUILD_ACTIVE_PATHS = Object.freeze([
    ...COURSEWARE_MUTABLE_FILES.filter((fileName) => !['tiku-context.json', 'teacher-request.md'].includes(fileName)),
    'style-previews',
]);

const COURSEWARE_SNAPSHOT_DIRECTORIES = Object.freeze(['style-previews']);

function compactMode(value) {
    return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

export function resolveCoursewareOperationMode({ requestedMode, rebuildMode, hasExistingAssets }) {
    const requested = compactMode(requestedMode);
    if (COURSEWARE_OPERATION_MODES.includes(requested)) return requested;

    const legacy = compactMode(rebuildMode);
    if (legacy === 'rebuild') return 'full-rebuild';
    if (legacy === 'audit' || legacy === 'inspect') return 'audit-only';

    return hasExistingAssets ? 'reuse-existing' : 'new-asset';
}

export function listExistingCoursewareFiles(projectPath, fileNames = COURSEWARE_PRIMARY_FILES) {
    return fileNames.filter((fileName) => fs.existsSync(path.join(projectPath, fileName)));
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function fileFingerprint(projectPath, fileName) {
    const filePath = path.join(projectPath, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const content = fs.readFileSync(filePath);
    return {
        file: fileName,
        bytes: content.length,
        sha256: sha256(content),
    };
}

export function snapshotCoursewareWorkspace(projectPath, runId) {
    const snapshotFiles = [
        ...COURSEWARE_MUTABLE_FILES,
        ...COURSEWARE_SNAPSHOT_DIRECTORIES.flatMap((relativeDir) => listRelativeFiles(projectPath, relativeDir)),
    ];
    const fingerprints = [...new Set(snapshotFiles)]
        .map((fileName) => fileFingerprint(projectPath, fileName))
        .filter(Boolean);
    if (!fingerprints.length) return { snapshotPath: null, files: [] };

    const snapshotPath = path.join(projectPath, '.courseware-runs', runId, 'before');
    fs.mkdirSync(snapshotPath, { recursive: true });
    for (const item of fingerprints) {
        const destination = path.join(snapshotPath, item.file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(projectPath, item.file), destination);
    }
    fs.writeFileSync(
        path.join(snapshotPath, 'snapshot-manifest.json'),
        JSON.stringify({
            schemaVersion: 'tongcheng.coursewareSnapshot.v1',
            runId,
            createdAt: new Date().toISOString(),
            files: fingerprints,
        }, null, 2),
        'utf8',
    );
    return { snapshotPath, files: fingerprints };
}

export function prepareCoursewareFullRebuild(projectPath, runId) {
    const activePaths = COURSEWARE_REBUILD_ACTIVE_PATHS.filter((relativePath) => (
        fs.existsSync(path.join(projectPath, relativePath))
    ));
    const snapshot = snapshotCoursewareWorkspace(projectPath, runId);
    if (activePaths.length && !snapshot.snapshotPath) {
        throw new Error('Full rebuild cannot isolate existing assets without a verified snapshot');
    }
    for (const item of snapshot.files) {
        const copied = fileFingerprint(snapshot.snapshotPath, item.file);
        if (!copied || copied.sha256 !== item.sha256 || copied.bytes !== item.bytes) {
            throw new Error(`Full rebuild snapshot verification failed: ${item.file}`);
        }
    }
    for (const relativePath of activePaths) {
        fs.rmSync(path.join(projectPath, relativePath), { recursive: true, force: true });
    }
    const isolation = {
        schemaVersion: 'tongcheng.coursewareRebuildIsolation.v1',
        runId,
        snapshotPath: snapshot.snapshotPath,
        isolatedPaths: activePaths,
        verifiedFiles: snapshot.files,
        isolatedAt: new Date().toISOString(),
    };
    const isolationPath = path.join(projectPath, '.courseware-runs', runId, 'rebuild-isolation.json');
    fs.mkdirSync(path.dirname(isolationPath), { recursive: true });
    fs.writeFileSync(isolationPath, `${JSON.stringify(isolation, null, 2)}\n`, 'utf8');
    return { ...snapshot, isolatedPaths: activePaths, isolationPath };
}

function listRelativeFiles(projectPath, relativeDir) {
    const absoluteDir = path.join(projectPath, relativeDir);
    if (!fs.existsSync(absoluteDir) || !fs.statSync(absoluteDir).isDirectory()) return [];
    const files = [];
    const visit = (absolutePath, relativePath) => {
        for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
            const childRelative = path.posix.join(relativePath.split(path.sep).join('/'), entry.name);
            const childAbsolute = path.join(absolutePath, entry.name);
            if (entry.isDirectory()) visit(childAbsolute, childRelative);
            else if (entry.isFile()) files.push(childRelative);
        }
    };
    visit(absoluteDir, relativeDir);
    return files;
}

function coursewareIdentity(tikuContext = {}) {
    const coursePackage = tikuContext.coursePackage || {};
    const lesson = tikuContext.lesson || {};
    return {
        coursePackageId: coursePackage.id || coursePackage.coursePackageId || null,
        lessonDbId: coursePackage.lessonDbId || lesson.dbId || null,
        lessonId: coursePackage.lessonId || lesson.lessonId || null,
        lessonTitle: coursePackage.lessonTitle || lesson.title || coursePackage.title || null,
        knowledgeIds: Array.isArray(lesson.knowledgeIds)
            ? lesson.knowledgeIds.map(String)
            : [],
    };
}

export function writeCoursewareRunContracts({
    projectPath,
    runId,
    operationMode,
    tikuContext,
    sourceLock,
    snapshot,
    generationMode = 'automatic-draft',
    teacherApprovedStyleId = null,
    patchScope = null,
    requestedAllowedWrites = [],
    outputTargets = ['html', 'pptx'],
    audience = 'student',
    budgetLimits = null,
}) {
    const now = new Date().toISOString();
    const identity = coursewareIdentity(tikuContext);
    const previousAssets = listExistingCoursewareFiles(projectPath, COURSEWARE_MUTABLE_FILES)
        .map((fileName) => fileFingerprint(projectPath, fileName))
        .filter(Boolean);
    const defaultAllowedWrites = COURSEWARE_MUTABLE_FILES.filter((fileName) => ![
        'tiku-context.json',
        'asset-request.json',
        'source-lock.json',
        'agent-run.json',
    ].includes(fileName));
    const allowedWrites = operationMode === 'incremental-update'
        ? [...new Set(requestedAllowedWrites.map(String))]
        : defaultAllowedWrites;
    allowedWrites.push(`reports/${runId}/*.json`, `.courseware-runs/${runId}/**`, `screenshots/${runId}/*.png`, 'style-previews/**');

    const request = {
        schemaVersion: 'tongcheng.coursewareAssetRequest.v1',
        runId,
        requestedAt: now,
        operationMode,
        source: 'tiku',
        target: identity,
        scope: {
            lessonOnly: true,
            workspacePath: projectPath,
            crossLessonWritesAllowed: false,
        },
        allowedWrites,
        forbiddenWrites: [
            'Teach/Learn production data',
            'other lesson workspaces',
            'published courseware without explicit publish approval',
        ],
        publish: {
            requested: false,
            approvalRequired: true,
        },
    };
    const lock = {
        schemaVersion: 'tongcheng.coursewareSourceLock.v1',
        runId,
        createdAt: now,
        source: 'tiku',
        identity,
        tikuContextSha256: sha256(JSON.stringify(tikuContext || {})),
        upstream: sourceLock && typeof sourceLock === 'object' ? sourceLock : {},
        previousAssets,
        snapshotPath: snapshot?.snapshotPath || null,
    };
    const run = {
        ...createInitialCoursewareAgentRun({
            runId,
            operationMode,
            generationMode,
            target: identity,
            teacherApprovedStyleId,
            patchScope,
            allowedWrites,
            outputTargets,
            audience,
            budgetLimits,
            now,
        }),
        contracts: {
            request: 'asset-request.json',
            sourceLock: 'source-lock.json',
        },
    };

    fs.writeFileSync(path.join(projectPath, 'asset-request.json'), JSON.stringify(request, null, 2), 'utf8');
    fs.writeFileSync(path.join(projectPath, 'source-lock.json'), JSON.stringify(lock, null, 2), 'utf8');
    writeCoursewareAgentRun(projectPath, run);
    return { request, sourceLock: lock, run };
}

export function updateCoursewareAgentRun(projectPath, patch) {
    return updateCoursewareAgentRunState(projectPath, patch);
}

export function writeCoursewareRunReport(projectPath, runId, role, report) {
    const safeRole = String(role || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-');
    const reportsPath = path.join(projectPath, 'reports', runId);
    fs.mkdirSync(reportsPath, { recursive: true });
    const payload = {
        schemaVersion: 'tongcheng.coursewareAgentReport.v1',
        ...(report && typeof report === 'object' ? report : {}),
        runId,
        agentRole: report?.agentRole || safeRole,
        subagentType: report?.subagentType || safeRole,
        lessonId: report?.lessonId || null,
        status: report?.status || 'failed',
        startedAt: report?.startedAt || null,
        completedAt: report?.completedAt || null,
        inputsRead: Array.isArray(report?.inputsRead) ? report.inputsRead : [],
        filesWritten: Array.isArray(report?.filesWritten) ? report.filesWritten : [],
        nextAgent: report?.nextAgent || null,
        blockers: Array.isArray(report?.blockers) ? report.blockers : [],
        checks: Array.isArray(report?.checks) ? report.checks : [],
        model: report?.model || null,
        sessionId: report?.sessionId || null,
        archivedAt: new Date().toISOString(),
    };
    const reportPath = path.join(reportsPath, `${safeRole}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2), 'utf8');
    return reportPath;
}

export function archiveCoursewareAgentReport(projectPath, runId, role) {
    const reportPath = path.join(projectPath, 'courseware-agent-report.json');
    if (!fs.existsSync(reportPath)) return null;
    try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        return writeCoursewareRunReport(projectPath, runId, role, report);
    } catch {
        return null;
    }
}
