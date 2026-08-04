import fs from 'node:fs';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { layoutKind, normalizedSlides, PALETTE as C } from './native-layout.js';
import { renderPptxPreviews, validatePptx } from '../courseware-renderer-utils.js';

export async function renderAnthropicPptxGenJs(input, outputDir) {
    const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE'; pptx.author = 'PilotDeck'; pptx.subject = input.lessonId || 'Tongcheng courseware'; pptx.title = input.slides[0]?.title || 'Courseware'; pptx.lang = 'zh-CN';
    pptx.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial', lang: 'zh-CN' };
    const slides = normalizedSlides(input);
    slides.forEach((item, index) => drawSlide(pptx, item, index));
    fs.mkdirSync(outputDir, { recursive: true });
    const pptxPath = path.join(outputDir, 'courseware.pptx'); await pptx.writeFile({ fileName: pptxPath });
    const validation = await validatePptx(pptxPath, slides.length, true);
    const previews = await renderPptxPreviews(pptxPath, path.join(outputDir, 'previews'));
    return { pptxPath, validation, previews, editable: true, warnings: [] };
}

function drawSlide(pptx, item, index) {
    const slide = pptx.addSlide(); const kind = layoutKind(item, index);
    slide.background = { color: kind === 'cover' ? C.dark : 'FCFCFD' };
    const notes = item.notes || '本页暂无额外教师备注。'; slide.addNotes(notes);
    if (kind === 'cover') {
        slide.addText(item.title, { x: 0.85, y: 1.35, w: 7.2, h: 1.6, fontFace: 'Arial', fontSize: 38, bold: true, color: C.white, breakLine: false, margin: 0.05, fit: 'shrink' });
        slide.addText(item.body.slice(0, 2).join('\n'), { x: 0.9, y: 3.35, w: 7.4, h: 1.2, fontSize: 21, color: 'CBD5E1', margin: 0.05, fit: 'shrink' });
        slide.addShape(pptx.ShapeType.arc, { x: 9.4, y: 1.1, w: 2.7, h: 2.7, rotate: 25, line: { color: C.orange, width: 8 }, fill: { color: C.dark, transparency: 100 } });
        return;
    }
    header(slide, item.title, index);
    if (kind === 'code') {
        slide.addText(item.code[0], { x: 0.72, y: 1.55, w: 7.2, h: 4.9, fontFace: 'Courier New', fontSize: 18, color: 'F8FAFC', fill: { color: C.dark }, margin: 0.28, breakLine: false, fit: 'shrink' });
        slide.addText(lines(item.body.slice(0, 5)), { x: 8.25, y: 1.7, w: 4.3, h: 4.3, fontSize: 21, color: C.ink, breakLine: false, margin: 0.08, fit: 'shrink' });
    } else if (kind === 'split') {
        const midpoint = Math.max(1, Math.ceil(item.body.length / 2)); panel(slide, 0.72, 1.65, 5.75, 4.7, item.body.slice(0, midpoint)); panel(slide, 6.85, 1.65, 5.75, 4.7, item.body.slice(midpoint));
    } else if (kind === 'steps') {
        (item.body.length ? item.body : [item.plainText]).slice(0, 4).forEach((text, i) => { slide.addShape(pptx.ShapeType.ellipse, { x: 0.9, y: 1.65 + i * 1.2, w: 0.65, h: 0.65, fill: { color: i === 3 ? C.green : C.orange }, line: { color: i === 3 ? C.green : C.orange } }); slide.addText(String(i + 1), { x: 0.9, y: 1.78 + i * 1.2, w: 0.65, h: 0.25, color: C.white, bold: true, align: 'center', margin: 0 }); slide.addText(text, { x: 1.85, y: 1.62 + i * 1.2, w: 10.5, h: 0.75, fontSize: 22, color: C.ink, margin: 0.03, fit: 'shrink' }); });
    } else panel(slide, 0.85, 1.8, 11.6, 4.5, item.body.length ? item.body : [item.plainText]);
    slide.addText('童澄未来', { x: 0.72, y: 7.08, w: 2, h: 0.2, fontSize: 10, color: C.muted, margin: 0 });
}
function header(slide, title, index) { slide.addText(`童澄课堂 · ${String(index + 1).padStart(2, '0')}`, { x: 0.72, y: 0.32, w: 5.5, h: 0.28, fontSize: 11, bold: true, color: C.orange, margin: 0 }); slide.addText(title, { x: 0.72, y: 0.72, w: 11.8, h: 0.65, fontSize: 27, bold: true, color: C.ink, margin: 0, fit: 'shrink' }); }
function panel(slide, x, y, w, h, content) { slide.addShape('roundRect', { x, y, w, h, rectRadius: 0.08, fill: { color: 'FFFFFF' }, line: { color: C.line } }); slide.addText(lines(content.slice(0, 6)), { x: x + 0.35, y: y + 0.35, w: w - 0.7, h: h - 0.7, fontSize: 22, color: C.ink, margin: 0.04, breakLine: false, fit: 'shrink' }); }
function lines(values) { return values.join('\n\n'); }
