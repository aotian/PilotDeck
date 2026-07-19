import fs from 'node:fs';
import path from 'node:path';
import { writeCoursewareRunReport } from '../courseware-run-policy.js';

const ROLE_BY_PHASE = {
    requirement: 'courseware-requirement',
    outline: 'courseware-outline',
    script: 'courseware-script',
    exercise: 'courseware-exercise',
    deck: 'courseware-deck',
    video: 'courseware-video',
    review: 'courseware-review',
};

const INPUTS_BY_PHASE = {
    requirement: ['teacher-request.md', 'tiku-context.json', 'asset-request.json', 'source-lock.json'],
    outline: ['brief.md', 'tiku-context.json'],
    script: ['brief.md', 'course-outline.md', 'pitfalls.md'],
    exercise: ['brief.md', 'course-outline.md', 'tiku-context.json'],
    video: ['brief.md', 'course-outline.md', 'teacher-script.md', 'courseware-slides.json'],
    review: [
        'brief.md', 'course-outline.md', 'teacher-script.md', 'exercises.md',
        'courseware-slides.json', 'video-script.md', 'tiku-context.json',
        'asset-request.json', 'source-lock.json', 'agent-run.json', 'visual-quality-report.json',
    ],
};

function reportIo(request) {
    const inputs = request.phase === 'deck'
        ? [
            'brief.md', 'course-outline.md', 'pitfalls.md', 'teacher-script.md',
            'exercises.md', 'tiku-context.json', 'design-brief.json',
            ...(['produce', 'repair'].includes(request.action) ? ['approved-style.json'] : []),
        ]
        : (INPUTS_BY_PHASE[request.phase] || []);
    const outputs = {
        requirement: ['brief.md'],
        outline: ['course-outline.md', 'pitfalls.md'],
        script: ['teacher-script.md'],
        exercise: ['exercises.md'],
        video: ['video-script.md'],
        review: ['courseware-package.json', 'generator-handoff.json'],
    }[request.phase] || (request.action === 'style-preview'
        ? ['design-brief.json', 'deck-plan.md', 'style-previews/style-a/style.json', 'style-previews/style-b/style.json', 'style-previews/style-c/style.json']
        : request.action === 'repair'
            ? ['courseware-slides.json']
            : ['deck-plan.md', 'courseware-slides.json']);
    return {
        inputsRead: inputs.filter((file) => fs.existsSync(path.join(request.projectPath, file))),
        filesWritten: outputs.filter((file) => fs.existsSync(path.join(request.projectPath, file))),
    };
}

export class FakeCoursewareAgentRunner {
    constructor(options = {}) {
        this.options = options;
        this.calls = [];
        this.active = new Set();
        this.overlap = [];
    }

    async run(request) {
        const role = ROLE_BY_PHASE[request.phase];
        const startedAt = new Date().toISOString();
        const call = { ...request, role, startedAt, event: 'started' };
        this.calls.push(call);
        for (const activeRole of this.active) this.overlap.push([activeRole, role].sort().join('+'));
        this.active.add(role);
        if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));

        const blocked = this.options.blockedPhase === request.phase;
        if (!blocked) this.writeOutputs(request);
        this.active.delete(role);
        const completedAt = new Date().toISOString();
        const missingOutput = this.options.missingOutputPhase === request.phase;
        const status = blocked ? 'blocked' : missingOutput ? 'failed' : 'ready';
        const blockers = blocked
            ? [this.options.blocker || `${request.phase} blocked by fake runner`]
            : missingOutput
                ? [`${request.phase} claimed ready but required output is missing`]
                : [];
        const existingReportPath = path.join(request.projectPath, 'reports', request.runId, `${role}.json`);
        const existingReport = fs.existsSync(existingReportPath)
            ? JSON.parse(fs.readFileSync(existingReportPath, 'utf8'))
            : null;
        const io = reportIo(request);
        const configuredUsage = this.options.usageByPhase?.[request.phase] || this.options.usage || {};
        const usage = {
            inputTokens: Number(configuredUsage.inputTokens || 100),
            outputTokens: Number(configuredUsage.outputTokens || 50),
            totalTokens: Number(configuredUsage.inputTokens || 100) + Number(configuredUsage.outputTokens || 50),
        };
        const modelCalls = Number(configuredUsage.modelCalls || 1);
        const report = {
            schemaVersion: 'tongcheng.coursewareAgentReport.v1',
            runId: request.runId,
            agentRole: role,
            subagentType: role,
            lessonId: request.lessonId || 'fixture-lesson',
            status,
            startedAt,
            completedAt,
            inputsRead: io.inputsRead,
            filesWritten: io.filesWritten,
            nextAgent: null,
            blockers,
            checks: [
                { name: 'subagent-started', status: 'pass', detail: `${role}-subagent-id` },
                { name: 'subagent-completed', status: status === 'ready' ? 'pass' : 'fail', detail: status },
            ],
            model: 'fake/courseware-model',
            sessionId: request.coordinatorSessionId || 'fake-coordinator-session',
            subagentId: `${role}-subagent-id`,
            lifecycleEvents: [
                { state: 'running', subagentType: role, subagentId: `${role}-subagent-id`, startedAt },
                { state: status === 'ready' ? 'completed' : 'failed', subagentType: role, subagentId: `${role}-subagent-id`, completedAt },
            ],
            action: request.action,
            usage,
            modelCalls,
            invocations: [
                ...(Array.isArray(existingReport?.invocations) ? existingReport.invocations : []),
                {
                    action: request.action,
                    subagentType: role,
                    subagentId: `${role}-subagent-id`,
                    sessionId: request.coordinatorSessionId || 'fake-coordinator-session',
                    startedAt,
                    completedAt,
                    status,
                    usage,
                    modelCalls,
                },
            ],
        };
        const reportPath = writeCoursewareRunReport(request.projectPath, request.runId, role, report);
        fs.writeFileSync(path.join(request.projectPath, 'courseware-agent-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        this.calls.push({ ...call, completedAt, event: 'completed', status });
        return {
            ...report,
            reportPath: path.relative(request.projectPath, reportPath),
            coordinatorSessionId: report.sessionId,
        };
    }

    writeOutputs(request) {
        const workspace = request.projectPath;
        switch (request.phase) {
            case 'requirement':
                write(workspace, 'brief.md', '# Fixture brief\n\nSubject: C++\nAudience: CSP-J\nAcceptance: classroom-ready\n');
                break;
            case 'outline':
                write(workspace, 'course-outline.md', '# Learning path\n\n1. Concept\n2. Example\n3. Practice\n');
                write(workspace, 'pitfalls.md', '# Pitfalls\n\n- Boundary conditions\n');
                break;
            case 'script':
                write(workspace, 'teacher-script.md', '# Teacher script\n\nAsk, reveal, summarize.\n');
                break;
            case 'exercise':
                write(workspace, 'exercises.md', '# Exercises\n\n- question_id: q-1\n- knowledge_id: k-1\n- difficulty: easy\n- source: tiku\n- answer: 3\n- analysis: trace values\n');
                break;
            case 'deck':
                if (request.action === 'style-preview') writeStylePreviews(workspace, request.runId);
                else if (request.action === 'repair') repairSlides(
                    workspace,
                    request.targetSlideIds,
                    this.options.mutateAllOnRepair,
                    this.options.noOpRepair,
                );
                else if (this.options.missingOutputPhase !== 'deck') writeSlides(workspace, request);
                break;
            case 'video':
                write(workspace, 'video-script.md', '# Video script\n\nScene, narration, board action.\n');
                break;
            case 'review':
                writeJson(workspace, 'courseware-package.json', {
                    schemaVersion: 'tiku.courseAsset.v1',
                    status: 'ready-for-teacher-review',
                    sourceOfTruth: 'courseware-slides.json',
                    publish: { allowed: false },
                });
                writeJson(workspace, 'generator-handoff.json', {
                    schemaVersion: 'tongcheng.generatorHandoff.v1',
                    status: 'ready-for-teacher-review',
                    engine: 'pilotdeck',
                    openmaicRendererUsed: false,
                });
                break;
            default:
                break;
        }
    }
}

export function createFakeRenderer(metrics = {}) {
    return {
        async capture({ screenshotPath }) {
            fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
            fs.writeFileSync(screenshotPath, await tinyPng());
        },
        async measure() {
            return {
                minFontPx: 24,
                minContrast: 7,
                overflowing: [],
                rootOverflow: false,
                textLength: 120,
                headingCount: 1,
                codeMinFontPx: 22,
                layoutSignature: `layout-${Math.random()}`,
                ...metrics,
            };
        },
    };
}

export async function fakeDeriveAssets({ projectPath }) {
    const slides = JSON.parse(fs.readFileSync(path.join(projectPath, 'courseware-slides.json'), 'utf8'));
    write(projectPath, 'deck.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}section{width:100%;height:100vh;overflow:hidden;box-sizing:border-box;break-after:page;page-break-after:always}@page{size:13.333in 7.5in;margin:0}@media print{section{height:7.5in}}</style></head><body>${slides.slides.map((slide) => slide.html).join('\n')}</body></html>`);
    writeJson(projectPath, 'slides-manifest.json', {
        schemaVersion: 'tiku.slidesManifest.v1',
        coursewareSlidesFile: 'courseware-slides.json',
        slideCount: slides.slides.length,
        slides: slides.slides.map((slide) => ({ id: slide.id, type: slide.type, title: slide.title })),
    });
}

export async function fakeVisualQuality(projectPath, runId, options = {}) {
    const slides = JSON.parse(fs.readFileSync(path.join(projectPath, 'courseware-slides.json'), 'utf8')).slides;
    const report = {
        schemaVersion: 'tongcheng.coursewareVisualQuality.v1',
        runId,
        status: 'pass',
        checks: [],
        slides: slides.map((slide) => ({
            slideId: slide.id,
            status: 'pass',
            issues: [],
            revisionRequired: false,
            screenshot: `screenshots/${runId}/${slide.id}.png`,
        })),
        revisedSlideIds: options.revisedSlideIds || [],
        checkedAt: new Date().toISOString(),
    };
    const screenshotRoot = path.join(projectPath, 'screenshots', runId);
    fs.mkdirSync(screenshotRoot, { recursive: true });
    for (const slide of slides) fs.writeFileSync(path.join(screenshotRoot, `${slide.id}.png`), await tinyPng());
    fs.writeFileSync(path.join(screenshotRoot, 'contact-sheet.png'), await tinyPng());
    report.contactSheet = `screenshots/${runId}/contact-sheet.png`;
    writeJson(projectPath, 'visual-quality-report.json', report);
    return report;
}

function writeStylePreviews(workspace, runId) {
    writeJson(workspace, 'design-brief.json', {
        schemaVersion: 'tongcheng.coursewareDesignBrief.v1',
        runId,
        lessonId: 'fixture-lesson',
        subject: 'C++',
        audience: 'CSP-J',
        classroomMode: 'teacher-led',
        projectionEnvironment: 'classroom-projector',
        durationMinutes: null,
        slideCountRange: { min: 14, max: 22 },
        contentDensity: 'medium',
        visualTone: ['clear', 'energetic'],
        layoutFamilies: ['narrative', 'diagram', 'trace'],
        illustrationMode: 'knowledge-diagram',
        diagramMode: 'step-flow',
        codeVisualMode: 'execution-trace',
        questionRevealMode: 'progressive',
        interactionPattern: 'predict-then-reveal',
        mustUseQuestionIds: ['q-1'],
        avoidPatterns: ['dashboard cards', 'tiny text'],
        brandConstraints: {},
        accessibilityConstraints: { minProjectionFontPx: 20 },
    });
    write(workspace, 'deck-plan.md', '# Deck plan\n\nPreview checkpoint only.\n');
    const styles = [
        {
            styleId: 'style-a', name: 'Narrative Track', designRationale: 'Large questions and progressive reveals.',
            informationHierarchy: 'question-first', layoutFamilies: ['full-bleed', 'split-stage'], diagramMode: 'story-flow', codeVisualMode: 'focus-line', interactionPattern: 'predict-reveal', illustrationMode: 'editorial',
            designTokens: { colors: { primary: '#b91c1c' }, typography: { display: 'serif' }, spacing: { page: 64 } },
        },
        {
            styleId: 'style-b', name: 'Systems Map', designRationale: 'Relationship maps and annotated examples.',
            informationHierarchy: 'map-first', layoutFamilies: ['radial-map', 'annotated-canvas'], diagramMode: 'node-map', codeVisualMode: 'state-table', interactionPattern: 'trace-together', illustrationMode: 'technical',
            designTokens: { colors: { primary: '#0369a1' }, typography: { display: 'sans' }, spacing: { page: 48 } },
        },
        {
            styleId: 'style-c', name: 'Workshop Board', designRationale: 'Hands-on challenge rhythm with answer layers.',
            informationHierarchy: 'task-first', layoutFamilies: ['workbench', 'before-after'], diagramMode: 'process-lane', codeVisualMode: 'terminal-trace', interactionPattern: 'challenge-unlock', illustrationMode: 'marker',
            designTokens: { colors: { primary: '#15803d' }, typography: { display: 'rounded' }, spacing: { page: 40 } },
        },
    ];
    for (const style of styles) {
        writeJson(workspace, `style-previews/${style.styleId}/style.json`, style);
        for (const pageType of ['cover', 'concept', 'example', 'practice']) {
            write(workspace, `style-previews/${style.styleId}/${pageType}.html`, stylePreviewHtml(style, pageType));
        }
    }
}

function writeSlides(workspace, request) {
    if (!fs.existsSync(path.join(workspace, 'design-brief.json'))) writeStylePreviews(workspace, request.runId);
    const selected = readOptionalJson(path.join(workspace, 'approved-style.json'))?.teacherApprovedStyleId || 'subject-template-cpp';
    const tikuContext = readOptionalJson(path.join(workspace, 'tiku-context.json')) || {};
    const types = ['cover', 'concept', 'example', 'concept', 'practice', 'summary'];
    const slideHtml = [
        `<section class="full-bleed" data-style="${selected}" style="height:100%;padding:72px;background:#172033;color:#ffffff;display:flex;flex-direction:column;justify-content:center"><p style="font-size:22px;color:#7dd3fc">变量与表达式</p><h1 style="font-size:58px;max-width:760px">让代码执行过程看得见</h1><p style="font-size:26px;max-width:660px">读一行，更新一次状态，验证最终答案。</p></section>`,
        `<section class="diagram" data-style="${selected}" style="height:100%;padding:56px;background:#f8fafc;color:#111827"><h1 style="font-size:40px">赋值不是等式，是一次状态更新</h1><div class="diagram-flow" style="display:flex;align-items:center;justify-content:center;gap:28px;margin-top:90px"><div style="font-size:28px;border:3px solid #0369a1;padding:28px">旧值 x = 1</div><div style="font-size:46px;color:#0369a1">→</div><div style="font-size:28px;border:3px solid #0f766e;padding:28px">执行 x = x + 2</div><div style="font-size:46px;color:#0f766e">→</div><div style="font-size:28px;background:#0f766e;color:#ffffff;padding:31px">新值 x = 3</div></div></section>`,
        `<section class="trace" data-style="${selected}" style="height:100%;padding:48px;background:#ffffff;color:#111827"><h1 style="font-size:38px">沿着代码逐行追踪</h1><div style="display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:28px"><pre style="font-size:22px;background:#111827;color:#f8fafc;padding:28px;line-height:1.8">int x = 1;\nx = x + 2;\ncout &lt;&lt; x;</pre><div style="font-size:24px"><p style="padding:18px;border-left:6px solid #0284c7">第 1 行：x = 1</p><p style="padding:18px;border-left:6px solid #0f766e">第 2 行：x = 3</p><p style="padding:18px;background:#ecfdf5">输出：3</p></div></div></section>`,
        `<section class="compare" data-style="${selected}" style="height:100%;padding:52px;background:#fff7ed;color:#111827"><h1 style="font-size:40px">两个常见读法，哪一个对？</h1><div style="display:grid;grid-template-columns:1fr 1fr;gap:36px;margin-top:56px"><div style="padding:32px;background:#ffffff;border-top:8px solid #dc2626"><h2 style="font-size:30px">错误：把 = 当数学等号</h2><p style="font-size:24px">会困在“x 怎么等于 x + 2”的疑问里。</p></div><div style="padding:32px;background:#ffffff;border-top:8px solid #16a34a"><h2 style="font-size:30px">正确：先算右边，再写回左边</h2><p style="font-size:24px">变量像可擦写的小白板，值会变化。</p></div></div></section>`,
        `<section class="practice" data-style="${selected}" data-question-id="q-1" style="height:100%;padding:56px;background:#ecfeff;color:#111827"><p style="font-size:22px;color:#0e7490">先预测，再揭示</p><h1 style="font-size:40px">连续执行三次更新，最终 x 是多少？</h1><div style="margin-top:46px;padding:32px;background:#ffffff;border:3px dashed #0891b2"><pre style="font-size:24px;background:#164e63;color:#ffffff;padding:24px">int x = 2;\nx = x * 3;\nx = x - 1;</pre><p style="font-size:28px">请写出每一步的 x，而不是只报最终答案。</p></div></section>`,
        `<section class="map" data-style="${selected}" style="height:100%;padding:52px;background:#f0fdf4;color:#111827"><h1 style="font-size:40px">今天的执行轨迹地图</h1><div class="diagram-flow" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:70px"><div style="font-size:25px;padding:28px;background:#ffffff;border-bottom:7px solid #2563eb">1. 找到变量初值</div><div style="font-size:25px;padding:28px;background:#ffffff;border-bottom:7px solid #7c3aed">2. 按顺序执行</div><div style="font-size:25px;padding:28px;background:#ffffff;border-bottom:7px solid #16a34a">3. 每行更新状态</div></div><p style="font-size:28px;margin-top:60px;text-align:center">代码阅读的核心动作：顺序、计算、写回、检查。</p></section>`,
    ];
    const slides = slideHtml.map((html, index) => ({
        id: `slide-${String(index + 1).padStart(2, '0')}`,
        order: index + 1,
        type: types[index],
        title: `Fixture ${index + 1}`,
        html,
        markdown: `# Fixture ${index + 1}`,
        notes: 'Teacher note',
        duration_minutes: null,
        student_visible: true,
        question_refs: index === 4 ? [{
            source: 'tiku',
            question_id: String(tikuContext.questions?.[0]?.question_id || 'q-1'),
            knowledge_id: String(tikuContext.questions?.[0]?.knowledge_id || 'k-1'),
        }] : [],
    }));
    writeJson(workspace, 'courseware-slides.json', {
        schemaVersion: 'tiku.coursewareSlides.v1',
        coursePackageId: tikuContext.coursePackage?.id || 'fixture-package',
        lessonId: tikuContext.coursePackage?.lessonId || 'fixture-lesson',
        title: 'Fixture courseware',
        approvedStyleId: selected,
        slides,
    });
    write(workspace, 'deck-plan.md', '# Deck plan\n\nSix varied fixture layouts.\n');
}

function stylePreviewHtml(style, pageType) {
    const title = {
        cover: '变量更新：让执行过程可见',
        concept: '先计算右侧，再写回左侧',
        example: '逐行追踪 x 的变化',
        practice: '预测下一步的变量值',
    }[pageType];
    if (style.styleId === 'style-a') {
        return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><main style="width:1280px;height:720px;padding:72px;box-sizing:border-box;background:#fff7ed;color:#7f1d1d;font-family:Georgia,serif;display:grid;grid-template-columns:2fr 1fr;gap:48px"><div><p style="font:22px Arial;color:#b91c1c">NARRATIVE TRACK · ${pageType}</p><h1 style="font-size:58px;line-height:1.15">${title}</h1><p style="font:26px Arial;color:#292524">以大问题开场，用故事节奏逐步揭示。</p></div><aside style="border-left:10px solid #b91c1c;padding:36px;font:28px Arial;align-self:center">想一想<br><strong>旧值去了哪里？</strong></aside></main></body></html>`;
    }
    if (style.styleId === 'style-b') {
        return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><main style="width:1280px;height:720px;padding:56px;box-sizing:border-box;background:#082f49;color:#f0f9ff;font-family:Arial,sans-serif"><p style="font-size:20px;color:#7dd3fc">SYSTEMS MAP / ${pageType}</p><h1 style="font-size:46px">${title}</h1><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:70px"><div style="border:2px solid #38bdf8;padding:28px;font-size:25px">输入状态</div><div style="background:#0369a1;padding:28px;font-size:25px">执行规则</div><div style="border:2px solid #2dd4bf;padding:28px;font-size:25px">输出状态</div></div><div style="height:5px;background:#38bdf8;margin-top:48px;width:72%"></div></main></body></html>`;
    }
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><main style="width:1280px;height:720px;padding:52px;box-sizing:border-box;background:#f0fdf4;color:#14532d;font-family:Arial,sans-serif"><header style="display:flex;justify-content:space-between;align-items:center;border-bottom:4px dashed #16a34a"><h1 style="font-size:42px">${title}</h1><span style="font-size:21px">WORKSHOP · ${pageType}</span></header><section style="display:grid;grid-template-columns:1fr 1fr;gap:34px;margin-top:52px"><div style="background:#ffffff;padding:30px;border:3px dashed #22c55e"><h2 style="font-size:30px">动手区</h2><p style="font-size:24px">写下每一步变量值</p></div><div style="background:#dcfce7;padding:30px"><h2 style="font-size:30px">复盘区</h2><p style="font-size:24px">圈出发生更新的语句</p></div></section></main></body></html>`;
}

function repairSlides(workspace, targetSlideIds = [], mutateAll = false, noOp = false) {
    const filePath = path.join(workspace, 'courseware-slides.json');
    const slides = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const targets = new Set((targetSlideIds || []).map(String));
    slides.slides = slides.slides.map((slide) => {
        if (noOp) return slide;
        if (targets.has(String(slide.id))) return { ...slide, title: `${slide.title} repaired`, html: slide.html.replace('font-size:12px', 'font-size:24px') };
        return mutateAll ? { ...slide, title: `${slide.title} unwanted-change` } : slide;
    });
    fs.writeFileSync(filePath, `${JSON.stringify(slides, null, 2)}\n`, 'utf8');
}

function write(workspace, relativePath, content) {
    const filePath = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(workspace, relativePath, value) {
    write(workspace, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readOptionalJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function tinyPng() {
    const sharpModule = await import('sharp');
    return sharpModule.default({ create: { width: 16, height: 9, channels: 4, background: '#ffffff' } }).png().toBuffer();
}
