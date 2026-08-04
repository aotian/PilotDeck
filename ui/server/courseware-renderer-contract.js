import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

export const COURSEWARE_RENDERERS = ['pilot-html', 'codex-artifact', 'anthropic-pptxgenjs', 'compare'];
export const STUDENT_FORBIDDEN_TERMS = /PilotDeck|OpenMAIC|\bagent\b|prompt|内部教研|老师讲稿|教师讲法|验收|落库|runId|question[_ -]?id|knowledge[_ -]?id/i;

export function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export function hashJson(value) {
    return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

export function resolveRenderer(value) {
    const renderer = String(value || '').trim();
    if (!COURSEWARE_RENDERERS.includes(renderer)) throw new Error(`Unknown courseware renderer: ${renderer || '(empty)'}`);
    return renderer;
}

export function buildRendererInput({ projectPath, runId, outputDir, operationMode = 'reuse-existing' }) {
    if (!projectPath || !runId) throw new Error('projectPath and runId are required');
    if (!['reuse-existing', 'audit-only', 'full-rebuild'].includes(operationMode)) throw new Error(`Unsupported renderer operationMode: ${operationMode}`);
    const slidesPath = path.join(projectPath, 'courseware-slides.json');
    if (!fs.existsSync(slidesPath)) throw new Error('reuse-existing requires courseware-slides.json');
    const source = readJson(slidesPath);
    const stylePath = path.join(projectPath, 'approved-style.json');
    const style = fs.existsSync(stylePath) ? readJson(stylePath) : null;
    const slides = Array.isArray(source?.slides) ? source.slides : [];
    if (!slides.length) throw new Error('courseware-slides.json has no slides');
    const questionRefsPath = path.join(projectPath, 'question-refs.json');
    const questionRefs = fs.existsSync(questionRefsPath) ? readJson(questionRefsPath) : collectQuestionRefs(source);
    const teacherScriptPath = path.join(projectPath, 'teacher-script.md');
    const teacherScript = fs.existsSync(teacherScriptPath) ? fs.readFileSync(teacherScriptPath, 'utf8') : '';
    return {
        schemaVersion: 'tongcheng.coursewareRendererInput.v1', runId,
        coursePackageId: source.coursePackageId || null, lessonDbId: source.lessonDbId || null,
        lessonId: source.lessonId || null, sourceOfTruth: 'courseware-slides.json',
        approvedStyleId: style?.teacherApprovedStyleId || null,
        approvedStyle: style, slideCount: slides.length, slides,
        teacherNotes: { script: teacherScript, slides: slides.map((slide) => ({ slideId: String(slide.id), notes: String(slide.notes || '') })) },
        studentVisibility: source.studentVisibility || 'student', questionRefs,
        outputDir: outputDir || path.join(projectPath, 'outputs'), operationMode,
        sourceHash: hashJson(source), styleHash: hashJson(style || {}),
    };
}

export function slideContent(slide) {
    const dom = new JSDOM(`<body>${slide.html || ''}</body>`);
    const document = dom.window.document;
    document.querySelectorAll('script,style,noscript').forEach((node) => node.remove());
    const title = slide.title || document.querySelector('h1,h2,h3')?.textContent?.trim() || `Slide ${slide.order || ''}`;
    const code = [...document.querySelectorAll('pre,code')].map((node) => node.textContent.trim()).filter(Boolean);
    const bullets = [...document.querySelectorAll('li')].map((node) => node.textContent.trim()).filter(Boolean);
    const paragraphs = [...document.querySelectorAll('p')].map((node) => node.textContent.trim()).filter(Boolean);
    const body = [...new Set([...paragraphs, ...bullets])].filter((line) => line && line !== title);
    return { title: String(title), body, bullets, code, plainText: document.body.textContent.replace(/\s+/g, ' ').trim() };
}

export function validateFrozenInput(input) {
    const blockers = [];
    if (input.slideCount !== input.slides.length) blockers.push('slideCount does not match slides');
    for (const slide of input.slides) {
        const text = slideContent(slide).plainText;
        if (input.studentVisibility === 'student' && STUDENT_FORBIDDEN_TERMS.test(text)) blockers.push(`${slide.id}: student-visible internal wording`);
    }
    return { ok: blockers.length === 0, blockers };
}

function collectQuestionRefs(source) {
    const refs = [];
    for (const slide of source.slides || []) {
        for (const ref of slide.questionRefs || slide.question_refs || []) refs.push({ ...ref, slideId: String(slide.id) });
    }
    return refs;
}

function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
