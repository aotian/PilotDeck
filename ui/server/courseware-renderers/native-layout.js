import { slideContent } from '../courseware-renderer-contract.js';

export const PALETTE = { ink: '172033', muted: '64748B', orange: 'F97316', pale: 'FFF7ED', green: '0F9F79', line: 'D8DEE9', white: 'FFFFFF', dark: '111827', red: 'D9485F' };

export function normalizedSlides(input) {
    return input.slides.map((slide, index) => ({ ...slideContent(slide), id: String(slide.id || `slide-${index + 1}`), type: slide.type || 'content', notes: String(slide.notes || input.teacherNotes?.slides?.[index]?.notes || '') }));
}

export function layoutKind(slide, index) {
    if (slide.type === 'cover' || index === 0) return 'cover';
    if (slide.code.length) return 'code';
    if (slide.type === 'practice' || slide.type === 'exercise') return 'practice';
    return index % 3 === 1 ? 'split' : index % 3 === 2 ? 'steps' : 'statement';
}
