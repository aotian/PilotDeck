#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCoursewareAgentOrchestrator } from '../ui/server/courseware-agent-orchestrator.js';
import { exportPilotDeckPdf, exportPilotDeckPptx } from '../ui/server/courseware-derived-assets.js';
import { writeCoursewareRunContracts } from '../ui/server/courseware-run-policy.js';
import {
    FakeCoursewareAgentRunner,
    fakeDeriveAssets,
} from '../ui/server/testing/fake-courseware-agent-runner.js';

const outputArgument = process.argv.find((value) => value.startsWith('--output='));
const workspace = outputArgument
    ? path.resolve(outputArgument.slice('--output='.length))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-7-agent-demo-'));
fs.mkdirSync(workspace, { recursive: true });

const runId = `demo-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const tikuContext = {
    schemaVersion: 'tiku.courseContext.v1',
    source: 'fixture',
    subject: 'cpp',
    coursePackage: {
        id: 'fixture-course-package',
        lessonId: 'fixture-lesson',
        lessonTitle: '变量状态与执行轨迹',
    },
    knowledge: {
        nodeId: 'fixture-k-1',
        nodeName: '变量与表达式',
        objectives: ['读取代码执行顺序', '追踪变量状态变化'],
    },
    questions: [{
        question_id: 'q-1',
        knowledge_id: 'fixture-k-1',
        difficulty: 'easy',
        content: '追踪三条赋值语句后的变量值。',
        answer: '3',
        analysis: '按语句顺序更新变量状态。',
        source: 'tiku',
    }],
};
fs.writeFileSync(path.join(workspace, 'tiku-context.json'), `${JSON.stringify(tikuContext, null, 2)}\n`);
fs.writeFileSync(path.join(workspace, 'teacher-request.md'), '# Fixture teacher request\n\nGenerate a high-quality classroom deck with variable state traces.\n');
writeCoursewareRunContracts({
    projectPath: workspace,
    runId,
    operationMode: 'new-asset',
    generationMode: 'high-quality',
    tikuContext,
    sourceLock: { source: 'fixture', production: false },
    snapshot: { snapshotPath: null, files: [] },
});

const runner = new FakeCoursewareAgentRunner({ delayMs: 5 });
const orchestrator = createCoursewareAgentOrchestrator({
    runner,
    deriveAssets: fakeDeriveAssets,
    validateWorkspace: async () => ({
        ok: true,
        issues: [],
        checks: [{ name: 'fixture-shared-validator', status: 'pass' }],
        fixture: true,
    }),
    exportPptx: exportPilotDeckPptx,
    exportPdf: exportPilotDeckPdf,
});

const paused = await orchestrator.run({ projectPath: workspace, runId });
if (paused.status !== 'awaiting-style-approval') {
    throw new Error(`Expected style approval checkpoint, received ${paused.status}`);
}
const completed = await orchestrator.approveStyle({
    projectPath: workspace,
    runId,
    styleId: 'style-b',
    teacherNotes: 'Fixture approval: use systems map layout.',
});
const patched = await orchestrator.patchSlides({
    projectPath: workspace,
    runId,
    patchScope: 'Enlarge and clarify the execution trace on slide-03',
    targetSlideIds: ['slide-03'],
    allowedWrites: ['courseware-slides.json'],
});
const result = {
    schemaVersion: 'tongcheng.courseware7AgentDemo.v1',
    fixture: true,
    productionApisCalled: false,
    j01ReadOrModified: false,
    workspace,
    runId,
    styleCheckpoint: paused,
    completed,
    patched,
    startedSubagentTypes: runner.calls
        .filter((call) => call.event === 'started')
        .map((call) => call.role),
    reportPaths: completed.reportPaths,
    generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(workspace, 'demo-result.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
