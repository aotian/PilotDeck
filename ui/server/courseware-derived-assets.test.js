import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { exportPilotDeckPptx } from './courseware-derived-assets.js';

const tempDirs = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('PilotDeck PPTX export', () => {
    it('derives PPTX from approved PilotDeck slide screenshots without OpenMAIC redesign', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-pptx-'));
        tempDirs.push(workspace);
        fs.mkdirSync(path.join(workspace, 'screenshots', 'run-pptx'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'courseware-slides.json'), JSON.stringify({
            schemaVersion: 'tiku.coursewareSlides.v1',
            title: 'Fixture deck',
            slides: [
                { id: 'slide-01', html: '<section><h1>One</h1></section>' },
                { id: 'slide-02', html: '<section><h1>Two</h1></section>' },
            ],
        }));
        fs.writeFileSync(path.join(workspace, 'approved-style.json'), JSON.stringify({ teacherApprovedStyleId: 'style-b' }));
        fs.writeFileSync(path.join(workspace, 'screenshots', 'run-pptx', 'slide-01.png'), Buffer.from('png-one'));
        fs.writeFileSync(path.join(workspace, 'screenshots', 'run-pptx', 'slide-02.png'), Buffer.from('png-two'));

        const result = await exportPilotDeckPptx(workspace, 'run-pptx', { generationMode: 'high-quality' });
        const zip = await JSZip.loadAsync(fs.readFileSync(result.path));
        expect(zip.file('ppt/slides/slide1.xml')).not.toBeNull();
        expect(zip.file('ppt/media/image2.png')).not.toBeNull();
        const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'pptx-export.json'), 'utf8'));
        expect(manifest.sourceOfTruth).toBe('courseware-slides.json');
        expect(manifest.approvedStyleSource).toBe('approved-style.json');
        expect(manifest.openmaicRendererUsed).toBe(false);
    });
});
