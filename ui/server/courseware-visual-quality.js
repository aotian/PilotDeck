import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { atomicWriteJson } from './courseware-agent-state.js';

const STYLE_IDS = ['style-a', 'style-b', 'style-c'];
const STYLE_PAGE_TYPES = ['cover', 'concept', 'example', 'practice'];
const INTERNAL_TERMS = /PilotDeck|OpenMAIC|\bagent\b|prompt|training-q-[\w-]+|question[_ -]?id|knowledge[_ -]?id|\bfixture\b|\brunId\b|内部教研|教师精讲抓手|为什么这样讲|三小时分配|讲题建议|老师讲稿|验收|落库|metadata|courseware_jobs/i;
const RAW_MATH = /(?<!\\)\$(?!\s)(?:[^$\n]|\\\$)+(?<!\s)(?<!\\)\$/;

export function validateCoursewareStylePreviews(projectPath) {
    const styles = STYLE_IDS.map((styleId) => {
        const stylePath = path.join(projectPath, 'style-previews', styleId, 'style.json');
        const style = readJson(stylePath);
        const missingPages = STYLE_PAGE_TYPES.filter((pageType) => {
            const pagePath = path.join(projectPath, 'style-previews', styleId, `${pageType}.html`);
            return !fs.existsSync(pagePath) || fs.statSync(pagePath).size === 0;
        });
        return {
            styleId,
            style,
            missingPages,
            structureSignature: styleStructureSignature(style),
            tokenSignature: crypto.createHash('sha256').update(JSON.stringify(style?.designTokens || {})).digest('hex'),
        };
    });
    const issues = [];
    for (const entry of styles) {
        if (!entry.style) issues.push(`${entry.styleId}: missing or invalid style.json`);
        if (entry.style?.styleId !== entry.styleId) issues.push(`${entry.styleId}: styleId mismatch`);
        if (entry.missingPages.length) issues.push(`${entry.styleId}: missing pages ${entry.missingPages.join(', ')}`);
        if (!entry.style?.name || !entry.style?.designRationale) issues.push(`${entry.styleId}: name/designRationale required`);
        if (!entry.style?.designTokens || typeof entry.style.designTokens !== 'object') issues.push(`${entry.styleId}: designTokens required`);
    }
    if (new Set(styles.map((entry) => entry.structureSignature)).size !== STYLE_IDS.length) {
        issues.push('Style directions must use different information hierarchy/layout/diagram/interaction structures, not only different colors');
    }
    if (new Set(styles.map((entry) => entry.tokenSignature)).size !== STYLE_IDS.length) {
        issues.push('Style directions must use different design tokens');
    }
    return { ok: issues.length === 0, issues, styles };
}

export async function renderCoursewareStylePreviews(projectPath, options = {}) {
    const renderer = options.renderer || createChromeRenderer(options);
    const rendered = [];
    for (const styleId of STYLE_IDS) {
        const styleDir = path.join(projectPath, 'style-previews', styleId);
        const previewHtmlPath = path.join(styleDir, '_preview.html');
        const previewPngPath = path.join(styleDir, 'preview.png');
        const frames = STYLE_PAGE_TYPES.map((pageType) => {
            const pageUrl = pathToFileUrl(path.join(styleDir, `${pageType}.html`));
            return `<iframe title="${pageType}" src="${pageUrl}"></iframe>`;
        }).join('\n');
        fs.writeFileSync(previewHtmlPath, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#d7dbe3}main{display:grid;gap:16px;padding:16px}iframe{display:block;width:1280px;height:720px;border:0;background:white;box-shadow:0 2px 8px rgba(0,0,0,.15)}
</style></head><body><main>${frames}</main></body></html>`, 'utf8');
        await renderer.capture({ htmlPath: previewHtmlPath, screenshotPath: previewPngPath, width: 1312, height: 2976 });
        rendered.push(path.relative(projectPath, previewPngPath));
    }
    const validation = validateCoursewareStylePreviews(projectPath);
    const missingScreenshots = rendered.filter((relativePath) => {
        const filePath = path.join(projectPath, relativePath);
        return !fs.existsSync(filePath) || fs.statSync(filePath).size === 0;
    });
    return {
        ...validation,
        ok: validation.ok && missingScreenshots.length === 0,
        issues: [...validation.issues, ...missingScreenshots.map((item) => `Missing screenshot: ${item}`)],
        previewPaths: rendered,
    };
}

export async function runCoursewareVisualQuality(projectPath, runId, options = {}) {
    const slidesPackage = readJson(path.join(projectPath, 'courseware-slides.json'));
    const slides = Array.isArray(slidesPackage?.slides) ? slidesPackage.slides : [];
    const renderer = options.renderer || createChromeRenderer(options);
    const renderRoot = path.join(projectPath, '.courseware-runs', runId, 'render');
    const screenshotRoot = path.join(projectPath, 'screenshots', runId);
    fs.mkdirSync(renderRoot, { recursive: true });
    fs.mkdirSync(screenshotRoot, { recursive: true });
    const targetSlideIds = Array.isArray(options.targetSlideIds)
        ? new Set(options.targetSlideIds.map(String))
        : null;
    const storedReport = readJson(path.join(projectPath, 'visual-quality-report.json'));
    const sameRunReport = storedReport?.runId === runId ? storedReport : null;
    const previousReport = targetSlideIds ? sameRunReport : null;
    const previousSlides = new Map((previousReport?.slides || []).map((slide) => [String(slide.slideId), slide]));

    const checkedSlides = [];
    for (const slide of slides) {
        if (targetSlideIds && !targetSlideIds.has(String(slide.id)) && previousSlides.has(String(slide.id))) {
            checkedSlides.push(previousSlides.get(String(slide.id)));
            continue;
        }
        const slideId = safeFileName(slide.id || `slide-${checkedSlides.length + 1}`);
        const htmlPath = path.join(renderRoot, `${slideId}.html`);
        const screenshotPath = path.join(screenshotRoot, `${slideId}.png`);
        const wrapped = wrapSlideForProjection(slide);
        fs.writeFileSync(htmlPath, wrapped, 'utf8');
        let metrics = null;
        let renderError = null;
        try {
            await renderer.capture({ htmlPath, screenshotPath, width: 1280, height: 720 });
            metrics = await renderer.measure({ htmlPath, width: 1280, height: 720 });
        } catch (error) {
            renderError = error instanceof Error ? error.message : String(error);
        }
        const issues = inspectSlide(slide, metrics, renderError, {
            audience: options.audience === 'teacher' ? 'teacher' : 'student',
        });
        const hasErrors = issues.some((item) => item.severity === 'error');
        checkedSlides.push({
            slideId: slide.id || slideId,
            status: hasErrors ? 'fail' : 'pass',
            issues,
            revisionRequired: hasErrors,
            screenshot: path.relative(projectPath, screenshotPath),
            metrics,
        });
    }

    applyDeckLevelChecks(checkedSlides, slides, projectPath);
    const contactSheet = await createScreenshotContactSheet(screenshotRoot, checkedSlides);
    const failedSlideIds = checkedSlides.filter((slide) => slide.status === 'fail').map((slide) => slide.slideId);
    const report = {
        schemaVersion: 'tongcheng.coursewareVisualQuality.v1',
        runId,
        status: failedSlideIds.length === 0 ? 'pass' : failedSlideIds.length < checkedSlides.length ? 'partial' : 'fail',
        checks: buildCheckSummary(checkedSlides),
        slides: checkedSlides,
        revisedSlideIds: [...new Set([
            ...(Array.isArray(sameRunReport?.revisedSlideIds) ? sameRunReport.revisedSlideIds : []),
            ...(Array.isArray(options.revisedSlideIds) ? options.revisedSlideIds : []),
        ].map(String))],
        contactSheet: path.relative(projectPath, contactSheet),
        checkedAt: new Date().toISOString(),
    };
    atomicWriteJson(path.join(projectPath, 'visual-quality-report.json'), report);
    return report;
}

async function createScreenshotContactSheet(screenshotRoot, slides) {
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default;
    const columns = 4;
    const thumbWidth = 320;
    const thumbHeight = 180;
    const labelHeight = 32;
    const gap = 16;
    const rows = Math.max(1, Math.ceil(slides.length / columns));
    const width = columns * thumbWidth + (columns + 1) * gap;
    const height = rows * (thumbHeight + labelHeight) + (rows + 1) * gap;
    const composites = [];
    for (let index = 0; index < slides.length; index += 1) {
        const slide = slides[index];
        const sourcePath = path.join(path.dirname(screenshotRoot), '..', slide.screenshot || '');
        const resolvedSource = fs.existsSync(sourcePath)
            ? sourcePath
            : path.join(screenshotRoot, `${safeFileName(slide.slideId)}.png`);
        if (!fs.existsSync(resolvedSource)) continue;
        const left = gap + (index % columns) * (thumbWidth + gap);
        const top = gap + Math.floor(index / columns) * (thumbHeight + labelHeight + gap);
        const thumbnail = await sharp(resolvedSource).resize(thumbWidth, thumbHeight, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
        const label = Buffer.from(`<svg width="${thumbWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111827"/><text x="12" y="22" font-family="Arial, sans-serif" font-size="15" fill="#ffffff">${escapeXml(slide.slideId)} · ${slide.status}</text></svg>`);
        composites.push({ input: thumbnail, left, top });
        composites.push({ input: label, left, top: top + thumbHeight });
    }
    const outputPath = path.join(screenshotRoot, 'contact-sheet.png');
    await sharp({ create: { width, height, channels: 4, background: '#d1d5db' } }).composite(composites).png().toFile(outputPath);
    return outputPath;
}

export function snapshotCoursewareSlidePatch(projectPath, runId, patchId) {
    const sourcePath = path.join(projectPath, 'courseware-slides.json');
    if (!fs.existsSync(sourcePath)) throw new Error('courseware-slides.json is required for a slide patch');
    const beforeRoot = path.join(projectPath, '.courseware-runs', runId, 'patches', patchId, 'before');
    fs.mkdirSync(beforeRoot, { recursive: true });
    const snapshotPath = path.join(beforeRoot, 'courseware-slides.json');
    fs.copyFileSync(sourcePath, snapshotPath);
    return path.relative(projectPath, snapshotPath);
}

export function mergeTargetedCoursewareSlidePatch({
    projectPath,
    beforeSnapshot,
    targetSlideIds,
    patchScope,
    allowedWrites = ['courseware-slides.json'],
}) {
    if (!patchScope || !String(patchScope).trim()) throw new Error('patchScope is required');
    if (!Array.isArray(targetSlideIds) || targetSlideIds.length === 0) throw new Error('targetSlideIds are required');
    if (!allowedWrites.includes('courseware-slides.json')) throw new Error('courseware-slides.json is not in allowedWrites');

    const before = readJson(path.join(projectPath, beforeSnapshot));
    const candidate = readJson(path.join(projectPath, 'courseware-slides.json'));
    const targetSet = new Set(targetSlideIds.map(String));
    const beforeSlides = Array.isArray(before?.slides) ? before.slides : [];
    const candidateSlides = new Map((candidate?.slides || []).map((slide) => [String(slide.id), slide]));
    const missingTargets = [...targetSet].filter((slideId) => !candidateSlides.has(slideId));
    if (missingTargets.length) throw new Error(`Patched deck is missing target slides: ${missingTargets.join(', ')}`);

    const mergedSlides = beforeSlides.map((slide) => {
        const slideId = String(slide.id);
        return targetSet.has(slideId) ? candidateSlides.get(slideId) : slide;
    });
    const merged = { ...before, ...candidate, slides: mergedSlides };
    fs.writeFileSync(path.join(projectPath, 'courseware-slides.json'), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

    const changedSlideIds = beforeSlides
        .filter((slide, index) => JSON.stringify(slide) !== JSON.stringify(mergedSlides[index]))
        .map((slide) => String(slide.id));
    const unauthorized = changedSlideIds.filter((slideId) => !targetSet.has(slideId));
    if (unauthorized.length) throw new Error(`Patch changed slides outside target scope: ${unauthorized.join(', ')}`);
    const blockers = changedSlideIds.length
        ? []
        : ['Patch produced no effective changes in the requested target slides'];
    return {
        patchScope,
        allowedWrites,
        targetSlideIds: [...targetSet],
        beforeSnapshot,
        changedFiles: ['courseware-slides.json'],
        changedSlideIds,
        blockers,
        validationResult: blockers.length ? 'failed' : 'pass',
    };
}

export function applyDeterministicCoursewareVisualRepairs({
    projectPath,
    targetSlideIds,
    visualReport = readJson(path.join(projectPath, 'visual-quality-report.json')),
}) {
    if (!Array.isArray(targetSlideIds) || targetSlideIds.length === 0) {
        throw new Error('targetSlideIds are required for deterministic visual repair');
    }
    const slidesPath = path.join(projectPath, 'courseware-slides.json');
    const deck = readJson(slidesPath);
    if (!Array.isArray(deck?.slides)) throw new Error('courseware-slides.json is required for deterministic visual repair');

    const targetSet = new Set(targetSlideIds.map(String));
    const reportBySlide = new Map((visualReport?.slides || []).map((slide) => [String(slide.slideId), slide]));
    const fixes = [];
    const changedSlideIds = [];
    const slides = deck.slides.map((slide) => {
        const slideId = String(slide.id);
        if (!targetSet.has(slideId)) return slide;
        const result = repairSlideHtml(String(slide.html || ''), reportBySlide.get(slideId)?.metrics, slideId);
        if (!result.changed) return slide;
        changedSlideIds.push(slideId);
        fixes.push(...result.fixes);
        return { ...slide, html: result.html };
    });
    const missingSlideIds = [...targetSet].filter((slideId) => !deck.slides.some((slide) => String(slide.id) === slideId));
    if (missingSlideIds.length) throw new Error(`Deterministic visual repair targets are missing: ${missingSlideIds.join(', ')}`);
    if (changedSlideIds.length) atomicWriteJson(slidesPath, { ...deck, slides });
    return {
        repairEngine: 'deterministic',
        targetSlideIds: [...targetSet],
        changedSlideIds,
        changedFiles: changedSlideIds.length ? ['courseware-slides.json'] : [],
        fixes,
        validationResult: changedSlideIds.length ? 'pass' : 'no-op',
    };
}

export function createChromeRenderer(options = {}) {
    const executable = options.chromeExecutable || findChromeExecutable();
    return {
        async capture({ htmlPath, screenshotPath, width, height }) {
            fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
            await runChrome(executable, [
                '--headless=new',
                '--disable-gpu',
                '--hide-scrollbars',
                '--no-sandbox',
                `--window-size=${width},${height}`,
                `--screenshot=${screenshotPath}`,
                '--virtual-time-budget=1200',
                pathToFileUrl(htmlPath),
            ]);
        },
        async measure({ htmlPath, width, height }) {
            const output = await runChrome(executable, [
                '--headless=new',
                '--disable-gpu',
                '--no-sandbox',
                `--window-size=${width},${height}`,
                '--dump-dom',
                '--virtual-time-budget=1200',
                pathToFileUrl(htmlPath),
            ]);
            const match = output.match(/<pre\b[^>]*\bid=["']pilotdeck-quality-metrics["'][^>]*>([\s\S]*?)<\/pre>/i);
            if (!match) return null;
            return JSON.parse(decodeHtmlEntities(match[1]));
        },
    };
}

function wrapSlideForProjection(slide) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;width:1280px;height:720px;overflow:hidden;background:#fff}#pilotdeck-slide{width:1280px;height:720px;overflow:hidden;box-sizing:border-box}#pilotdeck-slide>section{width:100%;height:100%;box-sizing:border-box}pre,code{white-space:pre-wrap}*{box-sizing:border-box}
</style></head><body><main id="pilotdeck-slide">${String(slide?.html || '')}</main><pre id="pilotdeck-quality-metrics" hidden></pre><script>
(() => {
 const root=document.getElementById('pilotdeck-slide');
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode(node){const text=(node.nodeValue||'').trim();const el=node.parentElement;if(!text||!el||el.closest('script,style,[hidden]'))return NodeFilter.FILTER_REJECT;const s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT}});
 const textElements=[];const seen=new Set();while(walker.nextNode()){const el=walker.currentNode.parentElement;if(el&&!seen.has(el)){seen.add(el);textElements.push(el)}}
 const domPath=(el)=>{const parts=[];let node=el;while(node&&node!==root){const parent=node.parentElement;if(!parent)break;const index=[...parent.children].indexOf(node)+1;parts.unshift((node.tagName||'node').toLowerCase()+':nth-child('+index+')');node=parent}return parts.join('>')};
 const parseColor=(value)=>{if(!value||value==='transparent')return null;const m=String(value).match(/[\\d.]+/g);if(!m||m.length<3)return null;return [Number(m[0]),Number(m[1]),Number(m[2]),m.length>3?Number(m[3]):1]};
 const composite=(top,bottom)=>{const a=top[3]+bottom[3]*(1-top[3]);if(a<=0)return [0,0,0,0];return [(top[0]*top[3]+bottom[0]*bottom[3]*(1-top[3]))/a,(top[1]*top[3]+bottom[1]*bottom[3]*(1-top[3]))/a,(top[2]*top[3]+bottom[2]*bottom[3]*(1-top[3]))/a,a]};
 const cssColor=(rgba)=>'rgb('+rgba.slice(0,3).map(value=>Math.round(value)).join(', ')+')';
 const lum=(rgb)=>{if(!rgb)return null;const v=rgb.slice(0,3).map(x=>{x/=255;return x<=.03928?x/12.92:Math.pow((x+.055)/1.055,2.4)});return .2126*v[0]+.7152*v[1]+.0722*v[2]};
 const contrast=(fg,bg)=>{const a=lum(fg),b=lum(bg);if(a==null||b==null)return null;return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
 const bgFor=(el)=>{const chain=[];let n=el;while(n){chain.unshift(n);n=n.parentElement}let resolved=[255,255,255,1];for(const node of chain){const color=parseColor(getComputedStyle(node).backgroundColor);if(color&&color[3]>0)resolved=composite(color,resolved)}return resolved};
 const fontEntries=textElements.map(el=>{const size=parseFloat(getComputedStyle(el).fontSize);const className=el.getAttribute?.('class')||'';const selector=[el.tagName?.toLowerCase()||'node',el.id?'#'+el.id:'',className?'.'+className.trim().replace(/\s+/g,'.'):''].join('');return {selector,domPath:domPath(el),text:(el.innerText||el.textContent||'').trim().replace(/\s+/g,' ').slice(0,80),size}}).filter(entry=>Number.isFinite(entry.size));
 const fonts=fontEntries.map(entry=>entry.size);
 const smallestFontSamples=fontEntries.sort((a,b)=>a.size-b.size).slice(0,40);
 const contrastEntries=textElements.map(el=>{const style=getComputedStyle(el);const background=bgFor(el);const rawForeground=parseColor(style.color);const foreground=rawForeground?composite(rawForeground,background):null;const ratio=contrast(foreground,background);const className=el.getAttribute?.('class')||'';const selector=[el.tagName?.toLowerCase()||'node',el.id?'#'+el.id:'',className?'.'+className.trim().replace(/\s+/g,'.'):''].join('');return {selector,domPath:domPath(el),text:(el.innerText||el.textContent||'').trim().replace(/\s+/g,' ').slice(0,80),foreground:foreground?cssColor(foreground):style.color,background:cssColor(background),ratio}}).filter(entry=>Number.isFinite(entry.ratio));
 const contrasts=contrastEntries.map(entry=>entry.ratio);
 const lowestContrastSamples=contrastEntries.sort((a,b)=>a.ratio-b.ratio).slice(0,40);
 const codeFonts=textElements.filter(el=>el.closest('pre,code')).map(el=>parseFloat(getComputedStyle(el).fontSize)).filter(Number.isFinite);
 const outside=(inner,outer)=>inner.left<outer.left-2||inner.top<outer.top-2||inner.right>outer.right+2||inner.bottom>outer.bottom+2;
 const rootRect=root.getBoundingClientRect();
 const overflowing=[];
 for(const el of textElements){
   const range=document.createRange();range.selectNodeContents(el);const textRect=range.getBoundingClientRect();
   let clipped=outside(textRect,rootRect);let ancestor=el;
   while(!clipped&&ancestor&&ancestor!==root){const s=getComputedStyle(ancestor);if(/hidden|clip/.test(s.overflowX+s.overflowY)&&outside(textRect,ancestor.getBoundingClientRect()))clipped=true;ancestor=ancestor.parentElement}
   if(clipped)overflowing.push(el.id||el.className||el.tagName);
 }
 const metrics={minFontPx:fonts.length?Math.min(...fonts):null,smallestFontSamples,minContrast:contrasts.length?Math.min(...contrasts):null,lowestContrastSamples,overflowing,rootOverflow:root.scrollWidth>1282||root.scrollHeight>722,textLength:(root.innerText||'').trim().length,textNodeCount:textElements.length,headingCount:root.querySelectorAll('h1,h2,h3').length,codeMinFontPx:codeFonts.length?Math.min(...codeFonts):null,layoutSignature:[root.firstElementChild?.className||root.firstElementChild?.tagName||'none',root.querySelectorAll('.card').length,root.querySelectorAll('[class*=grid]').length,root.querySelectorAll('svg,canvas,img').length,root.querySelectorAll('pre,code').length].join(':')};
 document.getElementById('pilotdeck-quality-metrics').textContent=JSON.stringify(metrics);
})();
</script></body></html>`;
}

function inspectSlide(slide, metrics, renderError, options = {}) {
    const html = String(slide?.html || '');
    const issues = [];
    if (renderError) issues.push(issue('render', 'error', renderError));
    if (!metrics) issues.push(issue('visual-metrics', 'error', 'Chrome visual metrics are missing; visual quality cannot pass'));
    if (!/<h1\b|<h2\b|<h3\b/i.test(html)) issues.push(issue('hierarchy', 'error', 'No visible heading hierarchy'));
    if (metrics?.rootOverflow || metrics?.overflowing?.length) issues.push(issue('overflow', 'error', `Overflow detected: ${(metrics.overflowing || []).join(', ') || 'root'}`));
    if (Number.isFinite(metrics?.minFontPx) && metrics.minFontPx < 18) issues.push(issue('readability', 'error', `Minimum font ${metrics.minFontPx}px is too small for projection`));
    if (/font-size\s*:\s*(?:[0-9]|1[0-7])px/i.test(html)) issues.push(issue('projection-legibility', 'error', 'Inline font size below 18px'));
    const malformedColors = findMalformedHexColors(html);
    if (malformedColors.length) issues.push(issue('css-validity', 'error', `Malformed CSS hex colors: ${malformedColors.join(', ')}`));
    if (Number.isFinite(metrics?.minContrast) && metrics.minContrast < 4.5) {
        const samples = (metrics.lowestContrastSamples || [])
            .filter((sample) => Number.isFinite(sample?.ratio) && sample.ratio < 4.5)
            .slice(0, 3)
            .map((sample) => `${sample.selector} "${sample.text}" ${sample.foreground} on ${sample.background} (${sample.ratio.toFixed(2)})`);
        const diagnostic = samples.length ? ` Offenders: ${samples.join('; ')}` : '';
        issues.push(issue('contrast', 'error', `Minimum contrast ${metrics.minContrast.toFixed(2)} is below 4.5.${diagnostic}`));
    }
    if (hasObviousLowContrast(html)) issues.push(issue('contrast', 'error', 'Foreground and background colors are too similar'));
    if ((metrics?.textLength || stripTags(html).length) > 1200) issues.push(issue('density', 'error', 'Student-visible text density is too high'));
    const studentVisible = options.audience !== 'teacher' && slide?.student_visible !== false;
    if (studentVisible && INTERNAL_TERMS.test(stripTags(html))) {
        issues.push(issue('student-visible-wording', 'error', 'Student HTML contains internal identifiers or teacher-only wording'));
    }
    if (/<script\b|javascript:|on(?:load|error|click)\s*=/i.test(html)) issues.push(issue('unsafe-links-scripts', 'error', 'Unsafe script or inline event handler detected'));
    if (RAW_MATH.test(stripTags(html)) && !/class=["'][^"']*katex/i.test(html)) issues.push(issue('math-rendering', 'error', 'Raw math delimiters are visible without rendered math markup'));
    if (/<pre\b|<code\b/i.test(html) && Number.isFinite(metrics?.codeMinFontPx) && metrics.codeMinFontPx < 20) {
        issues.push(issue('code-readability', 'error', `Code font ${metrics.codeMinFontPx}px is too small`));
    }
    if (/width\s*:\s*[2-9]\d{3}px/i.test(html)) issues.push(issue('mobile-desktop-compatibility', 'error', 'Fixed width exceeds the projection viewport'));
    if ((slide?.type === 'concept' || slide?.type === 'example') && !/<svg\b|<img\b|<canvas\b|class=["'][^"']*(?:flow|diagram|timeline|compare|trace)/i.test(html)) {
        issues.push(issue('diagram-quality', 'warning', 'Concept/example page has no explicit knowledge diagram or visual trace'));
    }
    return issues;
}

function applyDeckLevelChecks(checkedSlides, slides, projectPath) {
    const signatures = checkedSlides.map((entry) => entry.metrics?.layoutSignature).filter(Boolean);
    if (signatures.length >= 4) {
        const counts = new Map();
        for (const signature of signatures) counts.set(signature, (counts.get(signature) || 0) + 1);
        const [dominantSignature, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (dominantCount / signatures.length > 0.65) {
            checkedSlides.forEach((entry) => {
                if (entry.metrics?.layoutSignature === dominantSignature) {
                    entry.issues.push(issue('template-repetition', 'error', 'The same card/layout structure dominates the deck'));
                    entry.issues.push(issue('layout-variety', 'error', 'Page structure needs more variation'));
                    entry.status = 'fail';
                    entry.revisionRequired = true;
                }
            });
        }
    }
    const designBrief = readJson(path.join(projectPath, 'design-brief.json')) || {};
    const requiredQuestionIds = Array.isArray(designBrief.mustUseQuestionIds) ? designBrief.mustUseQuestionIds.map(String) : [];
    const allHtml = slides.map((slide) => String(slide.html || '')).join('\n');
    const missingQuestionIds = requiredQuestionIds.filter((questionId) => !allHtml.includes(questionId));
    if (missingQuestionIds.length && checkedSlides[0]) {
        checkedSlides[0].issues.push(issue('question-fidelity', 'error', `Required question IDs missing from slides: ${missingQuestionIds.join(', ')}`));
        checkedSlides[0].status = 'fail';
        checkedSlides[0].revisionRequired = true;
    }
}

function buildCheckSummary(slides) {
    const names = [
        'visual-metrics', 'hierarchy', 'readability', 'overflow', 'contrast', 'css-validity', 'density', 'layout-variety',
        'diagram-quality', 'code-readability', 'question-fidelity', 'projection-legibility',
        'template-repetition', 'student-visible-wording', 'mobile-desktop-compatibility',
        'math-rendering', 'unsafe-links-scripts',
    ];
    return names.map((name) => {
        const failures = slides.filter((slide) => slide.issues.some((item) => item.check === name && item.severity === 'error'));
        const warnings = slides.filter((slide) => slide.issues.some((item) => item.check === name && item.severity === 'warning'));
        return {
            name,
            status: failures.length ? 'fail' : warnings.length ? 'warning' : 'pass',
            slideIds: [...new Set([...failures, ...warnings].map((slide) => slide.slideId))],
        };
    });
}

function styleStructureSignature(style) {
    return JSON.stringify({
        informationHierarchy: style?.informationHierarchy || null,
        layoutFamilies: style?.layoutFamilies || null,
        diagramMode: style?.diagramMode || null,
        codeVisualMode: style?.codeVisualMode || null,
        interactionPattern: style?.interactionPattern || null,
        illustrationMode: style?.illustrationMode || null,
    });
}

function issue(check, severity, detail) {
    return { check, severity, detail };
}

function stripTags(html) {
    return String(html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasObviousLowContrast(html) {
    const pairs = [...String(html).matchAll(/style=["'][^"']*color\s*:\s*(#[0-9a-f]{6})[^"']*background(?:-color)?\s*:\s*(#[0-9a-f]{6})/gi)];
    return pairs.some((match) => colorDistance(match[1], match[2]) < 70);
}

function findMalformedHexColors(html) {
    const values = [];
    const declarations = String(html).matchAll(/(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?-color|fill|stroke)\s*:\s*(#[0-9a-f]+)/gi);
    const attributes = String(html).matchAll(/(?:fill|stroke)=["'](#[0-9a-f]+)["']/gi);
    for (const match of [...declarations, ...attributes]) {
        const value = match[1].toLowerCase();
        if (![4, 5, 7, 9].includes(value.length)) values.push(value);
    }
    return [...new Set(values)];
}

function repairSlideHtml(html, metrics, slideId) {
    const fixes = [];
    let normalizedHtml = normalizeMalformedHexColors(html, (before, after) => {
        fixes.push({ slideId, check: 'css-validity', before, after });
    });
    const dom = new JSDOM(`<body>${normalizedHtml}</body>`);
    const body = dom.window.document.body;

    for (const element of body.querySelectorAll('[style]')) {
        const match = String(element.style.fontSize || '').match(/^([\d.]+)px$/i);
        if (!match) continue;
        const current = Number(match[1]);
        const minimum = element.closest('pre,code') ? 20 : 18;
        if (!Number.isFinite(current) || current >= minimum) continue;
        element.style.fontSize = `${minimum}px`;
        fixes.push({
            slideId,
            check: element.closest('pre,code') ? 'code-readability' : 'readability',
            selector: describeElement(element),
            before: `${current}px`,
            after: `${minimum}px`,
        });
    }

    const fontSamples = Array.isArray(metrics?.smallestFontSamples) ? metrics.smallestFontSamples : [];
    const repairedFontElements = new Set();
    for (const sample of fontSamples) {
        const element = findMeasuredElement(body, sample, repairedFontElements);
        if (!element) continue;
        const minimum = element.closest('pre,code') ? 20 : 18;
        if (Number(sample?.size) >= minimum) continue;
        const inlineSize = Number.parseFloat(element.style.fontSize);
        if (Number.isFinite(inlineSize) && inlineSize >= minimum) continue;
        const before = element.style.fontSize || `${sample.size}px computed`;
        element.style.fontSize = `${minimum}px`;
        repairedFontElements.add(element);
        fixes.push({
            slideId,
            check: element.closest('pre,code') ? 'code-readability' : 'readability',
            selector: sample.selector,
            before,
            after: `${minimum}px`,
        });
    }

    const contrastSamples = Array.isArray(metrics?.lowestContrastSamples) ? metrics.lowestContrastSamples : [];
    const repairedContrastElements = new Set();
    for (const sample of contrastSamples.filter((entry) => Number(entry?.ratio) < 4.5)) {
        const element = findMeasuredElement(body, sample, repairedContrastElements);
        const replacement = bestContrastColor(sample?.background);
        if (!element || !replacement || replacement === element.style.color) continue;
        const before = element.style.color || String(sample.foreground || 'computed');
        element.style.color = replacement;
        repairedContrastElements.add(element);
        fixes.push({ slideId, check: 'contrast', selector: sample.selector, text: sample.text, before, after: replacement });
    }

    if (!fixes.length) return { changed: false, html, fixes };
    normalizedHtml = body.innerHTML;
    return { changed: normalizedHtml !== html, html: normalizedHtml, fixes };
}

function normalizeMalformedHexColors(html, onFix) {
    const normalize = (prefix, digits) => {
        if ([3, 4, 6, 8].includes(digits.length)) return `${prefix}#${digits}`;
        const normalized = digits.length >= 6
            ? digits.slice(0, 6)
            : digits.length === 5
                ? digits.slice(0, 4)
                : null;
        if (!normalized) return `${prefix}#${digits}`;
        onFix?.(`#${digits}`, `#${normalized}`);
        return `${prefix}#${normalized}`;
    };
    return String(html)
        .replace(/((?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?-color|fill|stroke)\s*:\s*)#([0-9a-f]+)\b/gi, (_, prefix, digits) => normalize(prefix, digits))
        .replace(/((?:fill|stroke)=["'])#([0-9a-f]+)(["'])/gi, (_, prefix, digits, suffix) => `${normalize(prefix, digits)}${suffix}`);
}

function findMeasuredElement(body, sample, excluded = new Set()) {
    if (sample?.domPath) {
        try {
            const byPath = body.querySelector(sample.domPath);
            if (byPath && !excluded.has(byPath)) return byPath;
        } catch {
            // Fall through for reports generated before domPath was available.
        }
    }
    const expectedText = normalizeText(sample?.text).slice(0, 80);
    let candidates = [];
    if (sample?.selector) {
        try {
            candidates = [...body.querySelectorAll(sample.selector)];
        } catch {
            candidates = [];
        }
    }
    const exact = candidates.find((element) => !excluded.has(element) && normalizeText(element.textContent).slice(0, 80) === expectedText);
    if (exact) return exact;
    const tagName = String(sample?.selector || '').match(/^[a-z][a-z0-9-]*/i)?.[0] || '*';
    const textMatches = [...body.querySelectorAll(tagName)]
        .filter((element) => !excluded.has(element) && normalizeText(element.textContent).slice(0, 80) === expectedText);
    return textMatches[0] || null;
}

function bestContrastColor(background) {
    const rgb = parseRgbColor(background);
    if (!rgb) return null;
    const candidates = ['#0f172a', '#ffffff'];
    return candidates
        .map((color) => ({ color, ratio: contrastRatio(parseHexColor(color), rgb) }))
        .sort((a, b) => b.ratio - a.ratio)[0]?.color || null;
}

function parseRgbColor(value) {
    const values = String(value || '').match(/[\d.]+/g)?.slice(0, 3).map(Number);
    return values?.length === 3 && values.every(Number.isFinite) ? values : null;
}

function parseHexColor(value) {
    return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

function contrastRatio(a, b) {
    const luminance = (rgb) => {
        const values = rgb.map((channel) => {
            const value = channel / 255;
            return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    };
    const left = luminance(a);
    const right = luminance(b);
    return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function normalizeText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function describeElement(element) {
    const id = element.id ? `#${element.id}` : '';
    const classes = element.classList.length ? `.${[...element.classList].join('.')}` : '';
    return `${element.tagName.toLowerCase()}${id}${classes}`;
}

function colorDistance(a, b) {
    const av = [1, 3, 5].map((index) => Number.parseInt(a.slice(index, index + 2), 16));
    const bv = [1, 3, 5].map((index) => Number.parseInt(b.slice(index, index + 2), 16));
    return Math.sqrt(av.reduce((sum, value, index) => sum + ((value - bv[index]) ** 2), 0));
}

function safeFileName(value) {
    return String(value).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function readJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function findChromeExecutable() {
    const candidates = [
        process.env.PILOTDECK_CHROME_EXECUTABLE,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ].filter(Boolean);
    const executable = candidates.find((candidate) => fs.existsSync(candidate));
    if (!executable) throw new Error('Chrome/Chromium executable is required for courseware visual rendering');
    return executable;
}

function runChrome(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error('Chrome render timed out'));
        }, 30000);
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) resolve(stdout);
            else reject(new Error(`Chrome exited ${code}: ${stderr.slice(-1000)}`));
        });
    });
}

function pathToFileUrl(filePath) {
    return pathToFileURL(path.resolve(filePath)).href;
}

function decodeHtmlEntities(value) {
    return String(value)
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function escapeXml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
