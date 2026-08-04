#!/usr/bin/env node
import path from 'node:path';
import { renderCourseware } from '../ui/server/courseware-renderer-registry.js';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || true]; }));
if (!args.workspace || !args.renderer) { console.error('Usage: node scripts/render-courseware.mjs --workspace=/path --renderer=pilot-html|codex-artifact|anthropic-pptxgenjs|compare [--run-id=id]'); process.exit(2); }
const result = await renderCourseware({ projectPath: path.resolve(args.workspace), runId: String(args['run-id'] || `render-${Date.now()}`), renderer: String(args.renderer), operationMode: String(args['operation-mode'] || 'reuse-existing'), renderers: args.renderers ? String(args.renderers).split(',') : undefined, fullRebuildAuthorized: args['authorize-full-rebuild'] === 'true' });
console.log(JSON.stringify(result, null, 2));
