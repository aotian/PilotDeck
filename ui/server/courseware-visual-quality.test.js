import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    applyDeterministicCoursewareVisualRepairs,
    mergeTargetedCoursewareSlidePatch,
    runCoursewareVisualQuality,
    snapshotCoursewareSlidePatch,
    validateCoursewareStylePreviews,
} from './courseware-visual-quality.js';
import { createFakeRenderer, FakeCoursewareAgentRunner } from './testing/fake-courseware-agent-runner.js';

const tempDirs = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('courseware visual quality', () => {
    it('requires three structurally different style directions and four representative pages each', async () => {
        const workspace = tempWorkspace();
        await new FakeCoursewareAgentRunner().run({
            projectPath: workspace,
            runId: 'run-style',
            phase: 'deck',
            action: 'style-preview',
            lessonId: 'fixture-lesson',
        });
        const validation = validateCoursewareStylePreviews(workspace);
        expect(validation.ok).toBe(true);
        expect(new Set(validation.styles.map((item) => item.structureSignature)).size).toBe(3);
        expect(new Set(validation.styles.map((item) => item.tokenSignature)).size).toBe(3);
    });

    it('detects overflow, small type, low contrast, and repeated layouts', async () => {
        const workspace = tempWorkspace();
        const slides = Array.from({ length: 4 }, (_, index) => ({
            id: `slide-0${index + 1}`,
            type: index === 0 ? 'cover' : 'concept',
            html: `<section class="card-grid" style="color:#777777;background:#787878"><h1 style="font-size:12px">Dense page</h1><div class="card">${'text '.repeat(260)}</div></section>`,
        }));
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify({ slides }));
        fs.writeFileSync(path.join(workspace, 'design-brief.json'), JSON.stringify({ mustUseQuestionIds: [] }));
        const report = await runCoursewareVisualQuality(workspace, 'run-visual', {
            renderer: createFakeRenderer({
                minFontPx: 12,
                minContrast: 1.1,
                overflowing: ['card-grid'],
                rootOverflow: true,
                textLength: 1300,
                layoutSignature: '4:1:0:0',
            }),
        });
        expect(report.status).not.toBe('pass');
        const checks = new Map(report.checks.map((check) => [check.name, check.status]));
        expect(checks.get('overflow')).toBe('fail');
        expect(checks.get('readability')).toBe('fail');
        expect(checks.get('contrast')).toBe('fail');
        expect(checks.get('template-repetition')).toBe('fail');
    });

    it('blocks visual approval when renderer metrics are missing', async () => {
        const workspace = tempWorkspace();
        writeSlides(workspace, '<section><h1 style="font-size:42px">Metrics required</h1></section>');
        const captureRenderer = createFakeRenderer();
        const report = await runCoursewareVisualQuality(workspace, 'run-null-metrics', {
            renderer: {
                capture: captureRenderer.capture,
                measure: async () => null,
            },
        });

        expect(report.status).toBe('fail');
        expect(report.slides[0].metrics).toBeNull();
        expect(report.slides[0].issues).toContainEqual(expect.objectContaining({
            check: 'visual-metrics',
            severity: 'error',
        }));
    });

    it('blocks malformed CSS hex colors instead of relying on browser fallback', async () => {
        const workspace = tempWorkspace();
        writeSlides(workspace, '<section style="color:#0f172afff;background:#ffffff"><h1 style="font-size:42px">Invalid color</h1></section>');

        const report = await runCoursewareVisualQuality(workspace, 'run-invalid-css-color', {
            renderer: createFakeRenderer(),
        });

        expect(report.status).toBe('fail');
        expect(report.slides[0].issues).toContainEqual(expect.objectContaining({
            check: 'css-validity',
            severity: 'error',
            detail: expect.stringContaining('#0f172afff'),
        }));
    });

    it('extracts real Chrome metrics from text nodes without counting default-size containers', async () => {
        const workspace = tempWorkspace();
        writeSlides(workspace, '<section style="color:#111827;background:#ffffff;overflow:hidden;padding:48px"><div><h1 style="font-size:42px;margin:0">Real Chrome</h1><p style="font-size:28px;margin:24px 0 0">Measured text</p></div></section>');

        const report = await runCoursewareVisualQuality(workspace, 'run-real-chrome');

        expect(report.status).toBe('pass');
        expect(report.slides[0].metrics).not.toBeNull();
        expect(report.slides[0].metrics.textNodeCount).toBe(2);
        expect(report.slides[0].metrics.minFontPx).toBe(28);
        expect(report.slides[0].metrics.minFontPx).not.toBe(16);
        expect(report.slides[0].metrics.lowestContrastSamples).toContainEqual(expect.objectContaining({
            selector: 'h1',
            domPath: 'section:nth-child(1)>div:nth-child(1)>h1:nth-child(1)',
            text: 'Real Chrome',
        }));
    }, 30000);

    it('composites transparent RGBA foregrounds and ancestor backgrounds in real Chrome', async () => {
        const workspace = tempWorkspace();
        writeSlides(workspace, '<section style="background:#000000;padding:48px"><div style="background:rgba(255,255,255,.5);padding:24px"><h1 style="font-size:42px;color:rgba(0,0,0,.5);margin:0">Composited contrast</h1></div></section>');

        const report = await runCoursewareVisualQuality(workspace, 'run-real-rgba');
        const sample = report.slides[0].metrics.lowestContrastSamples.find((entry) => entry.selector === 'h1');

        expect(report.slides[0].metrics).not.toBeNull();
        expect(sample.background).toBe('rgb(128, 128, 128)');
        expect(sample.foreground).toBe('rgb(64, 64, 64)');
        expect(sample.ratio).toBeLessThan(4.5);
        expect(report.slides[0].issues).toContainEqual(expect.objectContaining({ check: 'contrast', severity: 'error' }));
    }, 30000);

    it('blocks internal identifiers for students but allows teacher-only material', async () => {
        const html = '<section style="color:#111827;background:#ffffff"><h1 style="font-size:42px">教师讲稿</h1><p style="font-size:24px">fixture training-q-02 question_id knowledge_id runId</p></section>';
        const studentWorkspace = tempWorkspace();
        writeSlides(studentWorkspace, html);
        const student = await runCoursewareVisualQuality(studentWorkspace, 'run-student-audience', {
            renderer: createFakeRenderer(),
            audience: 'student',
        });
        expect(student.slides[0].issues).toContainEqual(expect.objectContaining({
            check: 'student-visible-wording',
            severity: 'error',
        }));

        const teacherWorkspace = tempWorkspace();
        writeSlides(teacherWorkspace, html);
        const teacher = await runCoursewareVisualQuality(teacherWorkspace, 'run-teacher-audience', {
            renderer: createFakeRenderer(),
            audience: 'teacher',
        });
        expect(teacher.slides[0].issues.some((entry) => entry.check === 'student-visible-wording')).toBe(false);
        expect(teacher.status).toBe('pass');
    });

    it('reports actual clipped text without flagging ordinary heading line boxes', async () => {
        const workspace = tempWorkspace();
        writeSlides(workspace, '<section style="color:#111827;background:#ffffff;padding:48px"><h1 style="font-size:42px;margin:0">Normal heading</h1><div style="height:20px;overflow:hidden;margin-top:20px"><span style="font-size:28px">This text is genuinely clipped</span></div></section>');

        const report = await runCoursewareVisualQuality(workspace, 'run-real-overflow');

        expect(report.status).toBe('fail');
        expect(report.slides[0].metrics).not.toBeNull();
        expect(report.slides[0].metrics.overflowing).toContain('SPAN');
        expect(report.slides[0].metrics.overflowing).not.toContain('H1');
        expect(report.slides[0].issues).toContainEqual(expect.objectContaining({ check: 'overflow', severity: 'error' }));
    }, 30000);

    it('preserves revised slide ids across a final full-deck recheck of the same run', async () => {
        const workspace = tempWorkspace();
        writeSlides(workspace, '<section style="color:#111827;background:#ffffff;padding:48px"><h1 style="font-size:42px;margin:0">Rechecked</h1></section>');
        fs.writeFileSync(path.join(workspace, 'visual-quality-report.json'), JSON.stringify({
            schemaVersion: 'tongcheng.coursewareVisualQuality.v1',
            runId: 'run-recheck',
            revisedSlideIds: ['slide-01'],
            slides: [],
        }));

        const report = await runCoursewareVisualQuality(workspace, 'run-recheck', {
            renderer: createFakeRenderer(),
        });

        expect(report.status).toBe('pass');
        expect(report.revisedSlideIds).toEqual(['slide-01']);
    });

    it('merges only target slide changes during a local repair', () => {
        const workspace = tempWorkspace();
        const original = {
            schemaVersion: 'tiku.coursewareSlides.v1',
            slides: [
                { id: 'slide-01', title: 'One', html: '<h1>One</h1>' },
                { id: 'slide-02', title: 'Two', html: '<h1>Two</h1>' },
                { id: 'slide-03', title: 'Three', html: '<h1>Three</h1>' },
            ],
        };
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify(original));
        const beforeSnapshot = snapshotCoursewareSlidePatch(workspace, 'run-patch', 'patch-1');
        const candidate = {
            ...original,
            slides: [
                { ...original.slides[0], title: 'Unwanted edit' },
                { ...original.slides[1], title: 'Two repaired' },
                { ...original.slides[2], title: 'Another unwanted edit' },
            ],
        };
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify(candidate));
        const result = mergeTargetedCoursewareSlidePatch({
            projectPath: workspace,
            beforeSnapshot,
            targetSlideIds: ['slide-02'],
            patchScope: 'Enlarge slide-02 code',
            allowedWrites: ['courseware-slides.json'],
        });
        const merged = JSON.parse(fs.readFileSync(path.join(workspace, 'courseware-slides.json'), 'utf8'));
        expect(merged.slides.map((slide) => slide.title)).toEqual(['One', 'Two repaired', 'Three']);
        expect(result.changedSlideIds).toEqual(['slide-02']);
        expect(result.validationResult).toBe('pass');
    });

    it('marks a target patch with no effective slide changes as failed', () => {
        const workspace = tempWorkspace();
        const original = {
            schemaVersion: 'tiku.coursewareSlides.v1',
            slides: [{ id: 'slide-01', title: 'Same', html: '<h1>Same</h1>' }],
        };
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify(original));
        const beforeSnapshot = snapshotCoursewareSlidePatch(workspace, 'run-no-op', 'patch-1');
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify(original));

        const result = mergeTargetedCoursewareSlidePatch({
            projectPath: workspace,
            beforeSnapshot,
            targetSlideIds: ['slide-01'],
            patchScope: 'Make a visible change',
            allowedWrites: ['courseware-slides.json'],
        });

        expect(result.changedSlideIds).toEqual([]);
        expect(result.validationResult).toBe('failed');
        expect(result.blockers.join(' ')).toContain('no effective changes');
    });

    it('deterministically repairs malformed colors, measured contrast, and small type on target slides only', async () => {
        const workspace = tempWorkspace();
        const untouched = '<section style="color:#111827;background:#ffffff"><h1 style="font-size:42px">Untouched</h1></section>';
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify({
            schemaVersion: 'tiku.coursewareSlides.v1',
            slides: [
                {
                    id: 'slide-01',
                    type: 'cover',
                    html: '<section style="background:#ff5c9a;overflow:hidden;padding:48px"><h1 style="font-size:16px;color:#ffffff;margin:0">Repair me</h1><p style="font-size:24px;color:#0f172afff;margin:24px 0 0">Supporting text</p></section>',
                },
                { id: 'slide-02', type: 'cover', html: untouched },
            ],
        }));
        fs.writeFileSync(path.join(workspace, 'design-brief.json'), JSON.stringify({ mustUseQuestionIds: [] }));
        const result = applyDeterministicCoursewareVisualRepairs({
            projectPath: workspace,
            targetSlideIds: ['slide-01'],
            visualReport: {
                slides: [{
                    slideId: 'slide-01',
                    metrics: {
                        minFontPx: 16,
                        smallestFontSamples: [{ selector: 'h1', text: 'Repair me', size: 16 }],
                        minContrast: 2.9,
                        lowestContrastSamples: [{
                            selector: 'h1',
                            text: 'Repair me',
                            foreground: 'rgb(255, 255, 255)',
                            background: 'rgb(255, 92, 154)',
                            ratio: 2.9,
                        }],
                    },
                }],
            },
        });
        const deck = readJson(path.join(workspace, 'courseware-slides.json'));

        expect(result.changedSlideIds).toEqual(['slide-01']);
        expect(result.fixes.map((fix) => fix.check)).toEqual(expect.arrayContaining(['css-validity', 'readability', 'contrast']));
        expect(deck.slides[0].html).toContain('font-size: 18px');
        expect(deck.slides[0].html).toContain('color: rgb(15, 23, 42)');
        expect(deck.slides[0].html).not.toContain('#0f172afff');
        expect(deck.slides[1].html).toBe(untouched);

        const report = await runCoursewareVisualQuality(workspace, 'run-deterministic-real-chrome');
        expect(report.slides.find((slide) => slide.slideId === 'slide-01').metrics).not.toBeNull();
        expect(report.slides.find((slide) => slide.slideId === 'slide-01').status).toBe('pass');
    }, 30000);

    it('leaves the deck byte-for-byte unchanged when deterministic repair has no applicable fix', () => {
        const workspace = tempWorkspace();
        writeSlides(workspace, '<section style="color:#111827;background:#ffffff"><h1 style="font-size:42px">Already valid</h1></section>');
        const slidesPath = path.join(workspace, 'courseware-slides.json');
        const before = fs.readFileSync(slidesPath);

        const result = applyDeterministicCoursewareVisualRepairs({
            projectPath: workspace,
            targetSlideIds: ['slide-01'],
            visualReport: { slides: [{ slideId: 'slide-01', metrics: { minFontPx: 42, minContrast: 17 } }] },
        });

        expect(result.validationResult).toBe('no-op');
        expect(result.changedSlideIds).toEqual([]);
        expect(fs.readFileSync(slidesPath)).toEqual(before);
    });

    it('uses Chrome DOM paths to repair duplicate text elements independently', () => {
        const workspace = tempWorkspace();
        writeSlides(workspace, '<section style="background:#ffffff"><h1 style="font-size:42px">Duplicates</h1><div style="color:#06d6a0;font-size:24px">6</div><div style="color:#06d6a0;font-size:24px">6</div></section>');

        const result = applyDeterministicCoursewareVisualRepairs({
            projectPath: workspace,
            targetSlideIds: ['slide-01'],
            visualReport: {
                slides: [{
                    slideId: 'slide-01',
                    metrics: {
                        lowestContrastSamples: [
                            { selector: 'div', domPath: 'section:nth-child(1)>div:nth-child(2)', text: '6', background: 'rgb(255, 255, 255)', ratio: 1.8 },
                            { selector: 'div', domPath: 'section:nth-child(1)>div:nth-child(3)', text: '6', background: 'rgb(255, 255, 255)', ratio: 1.8 },
                        ],
                    },
                }],
            },
        });
        const html = readJson(path.join(workspace, 'courseware-slides.json')).slides[0].html;

        expect(result.fixes.filter((fix) => fix.check === 'contrast')).toHaveLength(2);
        expect(html.match(/color: rgb\(15, 23, 42\)/g)).toHaveLength(2);
    });

    it('raises measured inherited code text from 18px to the 20px code threshold', () => {
        const workspace = tempWorkspace();
        writeSlides(workspace, '<section><h1 style="font-size:42px">Code</h1><p style="font-size:18px">Use <code>n = n + 1</code></p></section>');

        const result = applyDeterministicCoursewareVisualRepairs({
            projectPath: workspace,
            targetSlideIds: ['slide-01'],
            visualReport: {
                slides: [{
                    slideId: 'slide-01',
                    metrics: {
                        smallestFontSamples: [{
                            selector: 'code',
                            domPath: 'section:nth-child(1)>p:nth-child(2)>code:nth-child(1)',
                            text: 'n = n + 1',
                            size: 18,
                        }],
                    },
                }],
            },
        });
        const html = readJson(path.join(workspace, 'courseware-slides.json')).slides[0].html;

        expect(result.fixes).toContainEqual(expect.objectContaining({ check: 'code-readability', after: '20px' }));
        expect(html).toContain('font-size: 20px');
    });
});

function writeSlides(workspace, html) {
    fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify({
        schemaVersion: 'tiku.coursewareSlides.v1',
        slides: [{ id: 'slide-01', type: 'cover', html }],
    }));
    fs.writeFileSync(path.join(workspace, 'design-brief.json'), JSON.stringify({ mustUseQuestionIds: [] }));
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function tempWorkspace() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-courseware-visual-'));
    tempDirs.push(workspace);
    return workspace;
}
