import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    prepareCoursewareFullRebuild,
    resolveCoursewareOperationMode,
    snapshotCoursewareWorkspace,
    writeCoursewareRunReport,
    writeCoursewareRunContracts,
} from './courseware-run-policy.js';

const tempDirs = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-courseware-policy-'));
    tempDirs.push(dir);
    return dir;
}

describe('resolveCoursewareOperationMode', () => {
    it('reuses existing assets for an ambiguous generate request', () => {
        expect(resolveCoursewareOperationMode({ rebuildMode: 'generate', hasExistingAssets: true }))
            .toBe('reuse-existing');
    });

    it('creates a new asset only when no primary asset exists', () => {
        expect(resolveCoursewareOperationMode({ rebuildMode: 'generate', hasExistingAssets: false }))
            .toBe('new-asset');
    });

    it('requires the explicit legacy rebuild signal for a full rebuild', () => {
        expect(resolveCoursewareOperationMode({ rebuildMode: 'rebuild', hasExistingAssets: true }))
            .toBe('full-rebuild');
    });

    it('honors an explicit audit-only request', () => {
        expect(resolveCoursewareOperationMode({ requestedMode: 'audit_only', hasExistingAssets: true }))
            .toBe('audit-only');
    });

    it('snapshots an existing primary asset before a rebuild', () => {
        const workspace = tempWorkspace();
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), '{"slides":[1]}');
        const snapshot = snapshotCoursewareWorkspace(workspace, 'run-1');

        expect(snapshot.files.map((item) => item.file)).toContain('courseware-slides.json');
        expect(fs.readFileSync(path.join(snapshot.snapshotPath, 'courseware-slides.json'), 'utf8'))
            .toBe('{"slides":[1]}');
        expect(fs.existsSync(path.join(snapshot.snapshotPath, 'snapshot-manifest.json'))).toBe(true);
    });

    it('verifies the snapshot and isolates old rebuild outputs from the active workspace', () => {
        const workspace = tempWorkspace();
        fs.writeFileSync(path.join(workspace, 'tiku-context.json'), '{"source":"fixture"}');
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), '{"slides":["old"]}');
        fs.writeFileSync(path.join(workspace, 'brief.md'), '# Old brief');
        fs.mkdirSync(path.join(workspace, 'style-previews', 'style-a'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'style-previews', 'style-a', 'style.json'), '{"styleId":"old"}');

        const result = prepareCoursewareFullRebuild(workspace, 'run-isolate');

        expect(result.isolatedPaths).toEqual(expect.arrayContaining([
            'courseware-slides.json',
            'brief.md',
            'style-previews',
        ]));
        expect(fs.existsSync(path.join(workspace, 'courseware-slides.json'))).toBe(false);
        expect(fs.existsSync(path.join(workspace, 'brief.md'))).toBe(false);
        expect(fs.existsSync(path.join(workspace, 'style-previews'))).toBe(false);
        expect(fs.existsSync(path.join(workspace, 'tiku-context.json'))).toBe(true);
        expect(fs.readFileSync(path.join(result.snapshotPath, 'courseware-slides.json'), 'utf8'))
            .toBe('{"slides":["old"]}');
        expect(fs.readFileSync(path.join(result.snapshotPath, 'style-previews', 'style-a', 'style.json'), 'utf8'))
            .toBe('{"styleId":"old"}');
        expect(fs.existsSync(result.isolationPath)).toBe(true);
    });

    it('writes request, source-lock, and run contracts with publishing disabled', () => {
        const workspace = tempWorkspace();
        writeCoursewareRunContracts({
            projectPath: workspace,
            runId: 'run-2',
            operationMode: 'new-asset',
            tikuContext: {
                coursePackage: { id: 'pkg-1', lessonDbId: 'db-1', lessonId: 'lesson-01' },
            },
            sourceLock: { hasProductionSlides: false },
            snapshot: { snapshotPath: null },
        });

        const request = JSON.parse(fs.readFileSync(path.join(workspace, 'asset-request.json'), 'utf8'));
        const lock = JSON.parse(fs.readFileSync(path.join(workspace, 'source-lock.json'), 'utf8'));
        const run = JSON.parse(fs.readFileSync(path.join(workspace, 'agent-run.json'), 'utf8'));
        expect(request.operationMode).toBe('new-asset');
        expect(lock.identity.lessonDbId).toBe('db-1');
        expect(run.publish.allowed).toBe(false);
    });

    it('keeps role reports in an append-only run directory', () => {
        const workspace = tempWorkspace();
        const reportPath = writeCoursewareRunReport(workspace, 'run-3', 'courseware-deck', {
            status: 'ready',
            filesWritten: ['courseware-slides.json'],
        });
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        expect(report.runId).toBe('run-3');
        expect(report.agentRole).toBe('courseware-deck');
        expect(report.status).toBe('ready');
    });
});
