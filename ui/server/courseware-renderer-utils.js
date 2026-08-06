import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';

export async function runProcess(executable, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(executable)} exited ${code}: ${stderr.slice(-2000)}`)));
    });
}

export function findSoffice() {
    return [process.env.PILOTDECK_SOFFICE, '/Users/tongcheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice'].find((file) => file && fs.existsSync(file));
}

export async function renderPptxPreviews(pptxPath, outputDir) {
    const soffice = findSoffice();
    if (!soffice) throw new Error('LibreOffice/soffice is required for PPTX visual QA');
    fs.mkdirSync(outputDir, { recursive: true });
    await runProcess(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outputDir, pptxPath]);
    const pdfPath = path.join(outputDir, `${path.basename(pptxPath, '.pptx')}.pdf`);
    await runProcess('/opt/homebrew/bin/pdftoppm', ['-png', '-r', '110', pdfPath, path.join(outputDir, 'slide')]);
    const pngs = fs.readdirSync(outputDir).filter((file) => /^slide-\d+\.png$/.test(file)).sort();
    const montage = path.join(outputDir, 'montage.png');
    await makeMontage(pngs.map((file) => path.join(outputDir, file)), montage);
    fs.rmSync(pdfPath, { force: true });
    return { pdfPath: null, pngs: pngs.map((file) => path.join(outputDir, file)), montage };
}

export async function validatePptx(pptxPath, expectedSlides, expectNotes = true) {
    const blockers = []; const warnings = [];
    if (!fs.existsSync(pptxPath) || fs.statSync(pptxPath).size < 1000) blockers.push('PPTX is missing or empty');
    if (blockers.length) return { status: 'blocked', blockers, warnings, slideCount: 0, notesCount: 0 };
    const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
    const slideCount = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
    const notesCount = Object.keys(zip.files).filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)).length;
    if (slideCount !== expectedSlides) blockers.push(`PPTX page count ${slideCount} does not match source ${expectedSlides}`);
    if (!zip.file('[Content_Types].xml') || !zip.file('ppt/presentation.xml')) blockers.push('PPTX OOXML core parts are missing');
    if (expectNotes && notesCount !== expectedSlides) blockers.push(`Speaker notes count ${notesCount} does not match source ${expectedSlides}`);
    return { status: blockers.length ? 'blocked' : 'pass', blockers, warnings, slideCount, notesCount };
}

export async function makeMontage(files, outputPath) {
    if (!files.length) throw new Error('No slide previews available for montage');
    const thumbs = await Promise.all(files.map((file) => sharp(file).resize(384, 216, { fit: 'contain', background: '#ffffff' }).png().toBuffer()));
    const columns = Math.min(4, files.length); const rows = Math.ceil(files.length / columns); const gap = 12;
    await sharp({ create: { width: columns * 384 + (columns + 1) * gap, height: rows * 216 + (rows + 1) * gap, channels: 4, background: '#d1d5db' } })
        .composite(thumbs.map((input, index) => ({ input, left: gap + (index % columns) * (384 + gap), top: gap + Math.floor(index / columns) * (216 + gap) }))).png().toFile(outputPath);
}

export function writeJson(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
export function relativeFiles(root) { return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter((name) => fs.statSync(path.join(root, name)).isFile()).map(String).sort() : []; }
