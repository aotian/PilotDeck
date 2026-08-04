import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportPilotDeckPptx, exportPilotDeckPdf } from '../courseware-derived-assets.js';
import { makeMontage, runProcess, validatePptx } from '../courseware-renderer-utils.js';

export async function renderPilotHtml(input, outputDir, options = {}) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'courseware-slides.json'), `${JSON.stringify({ schemaVersion: 'tiku.coursewareSlides.v1', slides: input.slides }, null, 2)}\n`);
    fs.writeFileSync(path.join(outputDir, 'approved-style.json'), `${JSON.stringify(input.approvedStyle || {}, null, 2)}\n`);
    const deckPath = path.join(outputDir, 'deck.html'); fs.writeFileSync(deckPath, deckHtml(input));
    const screenshotDir = path.join(outputDir, 'screenshots', input.runId); fs.mkdirSync(screenshotDir, { recursive: true });
    const chrome = options.chromeExecutable || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    for (const slide of input.slides) {
        const htmlPath = path.join(outputDir, `.slide-${slide.id}.html`); fs.writeFileSync(htmlPath, singleSlideHtml(slide));
        await runProcess(chrome, ['--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars','--window-size=1280,720',`--screenshot=${path.join(screenshotDir, `${safe(slide.id)}.png`)}`,pathToFileURL(htmlPath).href]); fs.rmSync(htmlPath);
    }
    const screenshots = fs.readdirSync(screenshotDir).filter((file)=>file.endsWith('.png')).sort().map((file)=>path.join(screenshotDir,file)); const montage=path.join(screenshotDir,'montage.png'); await makeMontage(screenshots,montage);
    const exported = await exportPilotDeckPptx(outputDir, input.runId, { generationMode: input.approvedStyleId ? 'high-quality' : 'automatic-draft', fileName: 'courseware.pptx' });
    const pdf = await exportPilotDeckPdf(outputDir, input.runId, { fileName: 'courseware.pdf', chromeExecutable: chrome });
    const validation = await validatePptx(exported.path, input.slideCount, false);
    return { pptxPath: exported.path, htmlPath: deckPath, pdfPath: pdf.path, validation, previews: { pngs: screenshots, montage }, editable: 'limited', warnings: ['PPTX pages are screenshot-backed; edit the HTML source instead'] };
}
function deckHtml(input){return `<!doctype html><html><head><meta charset="utf-8"><style>${css()}body{width:auto;height:auto;overflow:visible;background:#d1d5db;display:grid;gap:24px;padding:24px}.page{box-shadow:0 8px 28px #0003}@media print{@page{size:13.333in 7.5in;margin:0}body{display:block;padding:0;background:white}.page{break-after:page;page-break-after:always;box-shadow:none}.page:last-child{break-after:auto}}</style></head><body>${input.slides.map((s)=>`<main class="page">${s.html}</main>`).join('')}</body></html>`;}
function singleSlideHtml(slide){return `<!doctype html><html><head><meta charset="utf-8"><style>${css()}</style></head><body><main class="page">${slide.html}</main></body></html>`;}
function css(){return `*{box-sizing:border-box}html,body{margin:0;width:1280px;height:720px;overflow:hidden;font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#172033}.page{width:1280px;height:720px;overflow:hidden;background:#fcfcfd}.page>section{width:100%;height:100%;min-height:720px;margin:0;padding:64px 76px}.page h1{font-size:64px;line-height:1.14;margin:90px 0 28px;max-width:900px}.page h2{font-size:44px;line-height:1.2;margin:0 0 42px}.page p,.page li{font-size:27px;line-height:1.55}.page li{margin:12px 0}.page pre{white-space:pre-wrap;background:#111827;color:#f8fafc;border-radius:8px;padding:30px 36px;font:24px/1.55 Menlo,monospace;max-height:390px;overflow:hidden}.page section:has(h1){background:#111827;color:white}.page section:has(h1) p{color:#cbd5e1}`;}
function safe(v){return String(v).replace(/[^A-Za-z0-9._-]+/g,'-');}
