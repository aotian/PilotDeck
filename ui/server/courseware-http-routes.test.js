import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { readCoursewareAgentRun, summarizeCoursewareAgentRun, updateCoursewareAgentRunState } from './courseware-agent-state.js';
import { createTongchengBridgeAuth, registerCoursewareHttpRoutes } from './courseware-http-routes.js';

const cleanups = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});

describe('courseware HTTP integration', () => {
    it('enforces bridge auth and returns 202 for a still-running generation', async () => {
        const fixture = await startFixtureServer({ runBehavior: 'pending' });
        const body = generationBody('http-running');

        const unauthorized = await fetch(`${fixture.url}/api/tongcheng/tiku/courseware-slides`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        expect(unauthorized.status).toBe(401);

        const response = await fixture.request('/api/tongcheng/tiku/courseware-slides', {
            method: 'POST',
            body,
        });
        expect(response.status).toBe(202);
        expect(response.body).toMatchObject({
            status: 'running',
            generationMode: 'high-quality',
            budgetStatus: 'within-budget',
        });
        expect(response.body.budgetUsage).toMatchObject({ modelCalls: 0, resumes: 0, revisions: 0 });
    });

    it('returns 422 from status and resume when persisted execution is blocked', async () => {
        const fixture = await startFixtureServer({ runBehavior: 'blocked' });
        const workspaceName = 'http-blocked';
        const created = await fixture.request('/api/tongcheng/tiku/courseware-slides', {
            method: 'POST',
            body: generationBody(workspaceName),
        });
        expect(created.status).toBe(422);
        const runId = created.body.runId;

        const status = await fixture.request(`/api/tongcheng/tiku/courseware-slides/status?workspaceName=${workspaceName}`);
        expect(status.status).toBe(422);
        expect(status.body.status).toBe('blocked');

        const resumed = await fixture.request('/api/tongcheng/tiku/courseware-slides', {
            method: 'POST',
            body: { ...generationBody(workspaceName), runId },
        });
        expect(resumed.status).toBe(422);
        expect(resumed.body.resumed).toBe(true);
        expect(fixture.calls.run.at(-1).countResume).toBe(true);
    });

    it('routes style approval and target patch through the same authenticated contract', async () => {
        const fixture = await startFixtureServer({ runBehavior: 'blocked' });
        const workspaceName = 'http-actions';
        const created = await fixture.request('/api/tongcheng/tiku/courseware-slides', {
            method: 'POST',
            body: generationBody(workspaceName),
        });
        const runId = created.body.runId;

        const approved = await fixture.request('/api/tongcheng/tiku/courseware-slides/style-approval', {
            method: 'POST',
            body: { workspaceName, runId, styleId: 'style-b' },
        });
        expect(approved.status).toBe(200);
        expect(fixture.calls.style).toContainEqual(expect.objectContaining({ runId, styleId: 'style-b' }));

        const patched = await fixture.request('/api/tongcheng/tiku/courseware-slides/patch', {
            method: 'POST',
            body: {
                workspaceName,
                runId,
                patchScope: 'Enlarge code',
                allowedWrites: ['courseware-slides.json'],
                targetSlideIds: ['slide-03', 'slide-04'],
            },
        });
        expect(patched.status).toBe(422);
        expect(fixture.calls.patch).toContainEqual(expect.objectContaining({
            runId,
            targetSlideIds: ['slide-03', 'slide-04'],
        }));
    });
});

async function startFixtureServer({ runBehavior }) {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-courseware-http-'));
    const calls = { run: [], style: [], patch: [] };
    const orchestrator = {
        async run(options) {
            calls.run.push(options);
            if (runBehavior === 'pending') return new Promise(() => {});
            updateCoursewareAgentRunState(options.projectPath, {
                status: 'blocked',
                currentPhase: 'outline',
                phaseUpdates: { outline: { status: 'blocked', blockers: ['fixture blocker'] } },
            });
            return summarizeCoursewareAgentRun(readCoursewareAgentRun(options.projectPath), options.projectPath);
        },
        async approveStyle(options) {
            calls.style.push(options);
            updateCoursewareAgentRunState(options.projectPath, { status: 'awaiting-teacher-approval' });
            return summarizeCoursewareAgentRun(readCoursewareAgentRun(options.projectPath), options.projectPath);
        },
        async patchSlides(options) {
            calls.patch.push(options);
            updateCoursewareAgentRunState(options.projectPath, { status: 'blocked', currentPhase: 'deck' });
            return summarizeCoursewareAgentRun(readCoursewareAgentRun(options.projectPath), options.projectPath);
        },
    };
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    registerCoursewareHttpRoutes(app, {
        auth: createTongchengBridgeAuth({ expectedToken: 'fixture-token', bindHost: '127.0.0.1' }),
        workspaceRoot,
        minimumTimeoutMs: 5,
        safeSlug: (value, fallback) => String(value || fallback || '').replace(/[^a-z0-9-]/gi, '-'),
        resolveWorkspaceName: () => 'fixture-workspace',
        resolveGenerationMode: (value) => value || 'automatic-draft',
        listAssetFiles: () => [],
        createAssetPackage: () => ({}),
        validateWorkspace: async () => ({ ok: true, issues: [] }),
        writeGenerationRequest: (projectPath) => fs.writeFileSync(path.join(projectPath, 'teacher-request.md'), '# Fixture\n'),
        writeApprovedStyle: () => null,
        getOrchestrator: () => orchestrator,
        apiPayload: (projectPath, workspaceName, extra = {}) => ({
            ...summarizeCoursewareAgentRun(readCoursewareAgentRun(projectPath), projectPath),
            ...extra,
            workspaceName,
        }),
        buildFallbackSlides: () => ({ slides: [] }),
        writeDerivedFiles: () => {},
        buildLegacyStatus: () => ({ status: 'pending' }),
    });
    const server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}`;
    cleanups.push(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });
    return {
        url,
        calls,
        async request(relativePath, options = {}) {
            const response = await fetch(`${url}${relativePath}`, {
                method: options.method || 'GET',
                headers: {
                    'content-type': 'application/json',
                    'x-tongcheng-handoff-token': 'fixture-token',
                },
                body: options.body ? JSON.stringify(options.body) : undefined,
            });
            return { status: response.status, body: await response.json() };
        },
    };
}

function generationBody(workspaceName) {
    return {
        workspaceName,
        operationMode: 'new-asset',
        generationMode: 'high-quality',
        timeoutMs: 5,
        outputTargets: ['html', 'pptx'],
        tikuContext: {
            schemaVersion: 'tiku.courseContext.v1',
            source: 'fixture',
            coursePackage: { id: 'fixture-package', lessonId: 'fixture-lesson' },
            questions: [],
        },
    };
}
