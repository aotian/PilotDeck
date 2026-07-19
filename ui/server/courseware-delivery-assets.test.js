import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCoursewareDeliveryAssets } from './courseware-delivery-assets.js';

const tempDirs = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('courseware delivery assets', () => {
    it('returns the original PilotDeck HTML content and a stable byte hash', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-delivery-'));
        tempDirs.push(workspace);
        const html = '<!doctype html><html><body><section>Original visual</section></body></html>';
        fs.writeFileSync(path.join(workspace, 'deck.html'), html);

        const result = readCoursewareDeliveryAssets(workspace);
        expect(result.deckHtml).toBe(html);
        expect(result.deckHtmlSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(readCoursewareDeliveryAssets(workspace)).toEqual(result);
    });

    it('does not invent a fallback when deck.html is missing', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-delivery-'));
        tempDirs.push(workspace);
        expect(readCoursewareDeliveryAssets(workspace)).toEqual({ deckHtml: null, deckHtmlSha256: null });
    });
});
