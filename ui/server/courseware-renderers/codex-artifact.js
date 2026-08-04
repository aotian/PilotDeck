import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { layoutKind, normalizedSlides } from './native-layout.js';
import { makeMontage, renderPptxPreviews, validatePptx } from '../courseware-renderer-utils.js';

const C = { ink: '#172033', muted: '#64748B', orange: '#F97316', pale: '#FFF7ED', green: '#0F9F79', line: '#D8DEE9', white: '#FFFFFF', dark: '#111827' };

export async function renderCodexArtifact(input, outputDir, options = {}) {
    const module = await loadArtifactTool(options.artifactNodeModules);
    const { Presentation, PresentationFile } = module;
    const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    const slides = normalizedSlides(input);
    slides.forEach((item, index) => drawSlide(presentation, item, index));
    fs.mkdirSync(outputDir, { recursive: true });
    const previewsDir = path.join(outputDir, 'previews'); fs.mkdirSync(previewsDir, { recursive: true });
    const previewFiles = [];
    for (const [index, slide] of presentation.slides.items.entries()) {
        const stem = `slide-${String(index + 1).padStart(2, '0')}`;
        await saveBlob(path.join(previewsDir, `${stem}.png`), await presentation.export({ slide, format: 'png', scale: 1 }));
        fs.writeFileSync(path.join(previewsDir, `${stem}.layout.json`), await (await slide.export({ format: 'layout' })).text());
        previewFiles.push(path.join(previewsDir, `${stem}.png`));
    }
    const montage = path.join(previewsDir, 'montage.png'); await makeMontage(previewFiles, montage);
    const pptxPath = path.join(outputDir, 'courseware.pptx'); const blob = await PresentationFile.exportPptx(presentation); await blob.save(pptxPath);
    const validation = await validatePptx(pptxPath, slides.length, true);
    let officePreviews = null;
    try { officePreviews = await renderPptxPreviews(pptxPath, path.join(outputDir, 'office-previews')); } catch (error) { validation.blockers.push(`Office rendering failed: ${error.message}`); validation.status = 'blocked'; }
    return { pptxPath, validation, previews: { pngs: previewFiles, montage, office: officePreviews }, editable: true, warnings: [] };
}

async function loadArtifactTool(nodeModules) {
    const roots = [nodeModules, process.env.PILOTDECK_CODEX_NODE_MODULES, '/Users/tongcheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'].filter(Boolean);
    for (const root of roots) {
        try { return await import(createRequire(path.join(root, 'package.json')).resolve('@oai/artifact-tool')); } catch { /* try next runtime */ }
    }
    throw new Error('@oai/artifact-tool is unavailable; set PILOTDECK_CODEX_NODE_MODULES to an authorized runtime');
}

function drawSlide(presentation, item, index) {
    const slide = presentation.slides.add(); const kind = layoutKind(item, index); slide.background.fill = kind === 'cover' ? C.dark : '#FCFCFD'; slide.speakerNotes.setText(item.notes || '本页暂无额外教师备注。');
    if (kind === 'cover') { text(slide, item.title, 80, 135, 760, 170, 60, C.white, true); text(slide, item.body.slice(0, 2).join('\n'), 84, 345, 720, 110, 28, '#CBD5E1'); shape(slide, 940, 120, 220, 380, '#1F2937', '#374151'); text(slide, 'IF\nELSE', 970, 225, 160, 120, 34, '#FDBA74', true, 'center', 'Arial'); return; }
    text(slide, `童澄课堂 · ${String(index + 1).padStart(2, '0')}`, 72, 32, 620, 28, 17, C.orange, true); text(slide, item.title, 72, 72, 1136, 62, 42, C.ink, true);
    if (kind === 'code') { shape(slide, 72, 165, 690, 455, C.dark, C.dark); text(slide, item.code[0], 105, 200, 625, 380, 25, '#F8FAFC', false, 'left', 'Courier New'); text(slide, item.body.slice(0, 5).join('\n'), 820, 190, 365, 370, 27, C.ink); }
    else if (kind === 'split') { panel(slide, item.body.slice(0, Math.ceil(item.body.length / 2)), 72, 175, 540, 420); panel(slide, item.body.slice(Math.ceil(item.body.length / 2)), 668, 175, 540, 420); }
    else if (kind === 'steps') item.body.slice(0, 4).forEach((line, i) => { shape(slide, 85, 165 + i * 110, 72, 72, i === 3 ? C.green : C.orange, i === 3 ? C.green : C.orange); text(slide, String(i + 1), 85, 183 + i * 110, 72, 34, 25, C.white, true, 'center'); text(slide, line, 190, 170 + i * 110, 960, 65, 28, C.ink); });
    else panel(slide, item.body.length ? item.body : [item.plainText], 85, 180, 1110, 410);
    text(slide, '童澄未来', 72, 678, 160, 20, 14, C.muted);
}
function shape(slide,x,y,w,h,fill,line){slide.shapes.add({geometry:'roundRect',position:{left:x,top:y,width:w,height:h},fill,line:{style:'solid',fill:line,width:1}});}
function text(slide,value,x,y,w,h,size,color,bold=false,alignment='left',fontFamily='Arial'){const s=slide.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{style:'solid',fill:'none',width:0}});s.text=value;s.text.style={fontSize:size,color,bold,alignment,fontFamily};return s;}
function panel(slide,lines,x,y,w,h){shape(slide,x,y,w,h,C.white,C.line);text(slide,lines.slice(0,6).join('\n'),x+32,y+32,w-64,h-64,27,C.ink);}
async function saveBlob(file, blob){await fs.promises.writeFile(file,new Uint8Array(await blob.arrayBuffer()));}
