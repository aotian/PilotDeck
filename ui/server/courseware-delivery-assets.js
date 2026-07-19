import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function readCoursewareDeliveryAssets(projectPath) {
    const deckPath = path.join(projectPath, 'deck.html');
    if (!fs.existsSync(deckPath)) return { deckHtml: null, deckHtmlSha256: null };
    const deckHtml = fs.readFileSync(deckPath, 'utf8');
    return {
        deckHtml,
        deckHtmlSha256: crypto.createHash('sha256').update(deckHtml).digest('hex'),
    };
}
