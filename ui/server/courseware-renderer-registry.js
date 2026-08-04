import fs from 'node:fs';
import path from 'node:path';
import { buildRendererInput, hashJson, resolveRenderer, validateFrozenInput } from './courseware-renderer-contract.js';
import { relativeFiles, writeJson } from './courseware-renderer-utils.js';
import { renderPilotHtml } from './courseware-renderers/pilot-html.js';
import { renderCodexArtifact } from './courseware-renderers/codex-artifact.js';
import { renderAnthropicPptxGenJs } from './courseware-renderers/anthropic-pptxgenjs.js';

const registry = new Map([['pilot-html', renderPilotHtml], ['codex-artifact', renderCodexArtifact], ['anthropic-pptxgenjs', renderAnthropicPptxGenJs]]);

export async function renderCourseware({ projectPath, runId, renderer, operationMode = 'reuse-existing', renderers, teacherApproval = false, fullRebuildAuthorized = false, options = {} }) {
    const selected = resolveRenderer(renderer);
    if (operationMode === 'full-rebuild' && !fullRebuildAuthorized) throw new Error('full-rebuild requires explicit authorization');
    const outputsRoot = path.join(projectPath, 'outputs');
    const input = buildRendererInput({ projectPath, runId, outputDir: outputsRoot, operationMode });
    const frozen = validateFrozenInput(input); if (!frozen.ok) throw new Error(`Renderer input blocked: ${frozen.blockers.join('; ')}`);
    writeJson(path.join(outputsRoot, runId, 'renderer-input.json'), input);
    if (operationMode === 'audit-only') return { status: 'ready-for-teacher-review', renderer: selected, input, validation: frozen };
    if (operationMode === 'full-rebuild') snapshotInputs(projectPath, runId);
    if (selected === 'compare') return renderComparison({ projectPath, input, renderers: renderers || [...registry.keys()], options });
    return renderOne({ projectPath, input, renderer: selected, options, teacherApproval });
}

async function renderOne({ projectPath, input, renderer, options, teacherApproval = false }) {
    const execute = registry.get(renderer); if (!execute) throw new Error(`Renderer is not registered: ${renderer}`);
    const root = path.join(projectPath, 'outputs', renderer); const stage = `${root}.tmp-${input.runId}`; fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
    const started = Date.now(); let result;
    try { result = await execute(input, stage, options); }
    catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
    if (result.validation?.status !== 'pass') { writeJson(path.join(stage, 'renderer-report.json'), reportFor(input, renderer, result, started)); throw new Error(`${renderer} validation blocked: ${(result.validation?.blockers || []).join('; ')}`); }
    const report = reportFor(input, renderer, result, started, root);
    writeJson(path.join(stage, 'visual-qa-report.json'), { schemaVersion:'tongcheng.coursewareRendererVisualQa.v1',runId:input.runId,renderer,status:'awaiting-human-review',slideCount:input.slideCount,previewGenerated:Boolean(result.previews),montage:report.visualQa.montage,warnings:['Programmatic file checks passed; visual quality still requires montage review.'],checkedAt:new Date().toISOString() });
    writeJson(path.join(stage, 'renderer-report.json'), report);
    const previous = `${root}.previous`; fs.rmSync(previous, { recursive: true, force: true }); if (fs.existsSync(root)) fs.renameSync(root, previous); fs.renameSync(stage, root);
    const storedReport = JSON.parse(fs.readFileSync(path.join(root, 'renderer-report.json'), 'utf8'));
    if (teacherApproval) promoteCanonical(projectPath, input.runId, renderer, storedReport, typeof teacherApproval === 'object' ? teacherApproval : { approvedBy: 'teacher' });
    return storedReport;
}

async function renderComparison({ projectPath, input, renderers, options }) {
    const selected = [...new Set(renderers.map(resolveRenderer))].filter((name) => name !== 'compare'); if (selected.length < 2) throw new Error('compare requires at least two concrete renderers');
    const sourceBefore = hashJson(input.slides); const results = [];
    for (const renderer of selected) { try { results.push(await renderOne({ projectPath, input, renderer, options: options[renderer] || options })); } catch (error) { results.push({ renderer, status: 'blocked', blockers: [error.message], sourceHash: input.sourceHash, styleHash: input.styleHash }); } }
    if (hashJson(input.slides) !== sourceBefore) throw new Error('A renderer mutated the frozen comparison input');
    const comparison = { schemaVersion: 'tongcheng.coursewareRendererComparison.v1', runId: input.runId, sourceHash: input.sourceHash, styleHash: input.styleHash, status: results.some((item)=>item.status==='blocked')?'blocked':'ready-for-teacher-review', results: results.map((item)=>({ renderer:item.renderer,status:item.status,slideCount:item.slideCount,editable:item.editable,durationMs:item.durationMs,outputFiles:item.outputFiles,validation:item.validation,visualQa:item.visualQa,warnings:item.warnings,blockers:item.blockers||[] })), teacherDecision: null, generatedAt: new Date().toISOString() };
    const dir=path.join(projectPath,'outputs','compare'); writeJson(path.join(dir,'renderer-comparison.json'),comparison); fs.writeFileSync(path.join(dir,'renderer-comparison.md'),humanComparison(comparison)); return comparison;
}

export function promoteCanonical(projectPath, runId, renderer, report, approval = {}) {
    if (!approval.approvedBy) throw new Error('Teacher approval is required before canonical promotion');
    if (report.status !== 'ready-for-teacher-review' || report.validation?.status !== 'pass') throw new Error('Blocked renderer output cannot be promoted');
    const canonical = { schemaVersion:'tongcheng.coursewareCanonicalRenderer.v1',runId,renderer,sourceHash:report.sourceHash,styleHash:report.styleHash,approvedBy:approval.approvedBy,approvedAt:new Date().toISOString(),outputDir:`outputs/${renderer}`,publishAllowed:false };
    writeJson(path.join(projectPath,'outputs','canonical-output.json'),canonical); return canonical;
}

function reportFor(input,renderer,result,started,finalRoot=path.join(path.dirname(path.dirname(result.pptxPath)),renderer)){
    const stageRoot=path.dirname(result.pptxPath);
    const montage=result.previews?.montage||result.previews?.office?.montage||null;
    const stableMontage=montage&&path.join(finalRoot,path.relative(stageRoot,montage));
    return { schemaVersion:'tongcheng.coursewareRendererReport.v1',renderer,rendererVersion:'1.0.1',runId:input.runId,sourceHash:input.sourceHash,styleHash:input.styleHash,outputFiles:relativeFiles(stageRoot),slideCount:input.slideCount,editable:result.editable,generatedAt:new Date().toISOString(),durationMs:Date.now()-started,status:result.validation?.status==='pass'?'ready-for-teacher-review':'blocked',validation:result.validation,visualQa:{status:result.previews?'awaiting-human-review':'blocked',montage:stableMontage},warnings:result.warnings||[],blockers:result.validation?.blockers||[],questionRefsHash:hashJson(input.questionRefs),teacherApprovalRequired:true,publishAllowed:false};
}
function snapshotInputs(projectPath,runId){const dir=path.join(projectPath,'.renderer-snapshots',runId);fs.mkdirSync(dir,{recursive:true});for(const f of ['courseware-slides.json','approved-style.json','question-refs.json']){const src=path.join(projectPath,f);if(fs.existsSync(src))fs.copyFileSync(src,path.join(dir,f));}}
function humanComparison(c){return `# Renderer comparison\n\nRun: ${c.runId}\n\n| Renderer | Status | Slides | Editable | Duration | Blockers |\n|---|---:|---:|---:|---:|---|\n${c.results.map(r=>`| ${r.renderer} | ${r.status} | ${r.slideCount||'-'} | ${r.editable??'-'} | ${r.durationMs||'-'} ms | ${(r.blockers||[]).join('; ')} |`).join('\n')}\n\nNo renderer is selected automatically. Teacher approval is required.\n`;}
