import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    COURSEWARE_PRIMARY_FILES,
    listExistingCoursewareFiles,
    prepareCoursewareFullRebuild,
    resolveCoursewareOperationMode,
    updateCoursewareAgentRun,
    writeCoursewareRunContracts,
} from './courseware-run-policy.js';
import { readCoursewareAgentRun } from './courseware-agent-state.js';

export function createTongchengBridgeAuth(options = {}) {
    return (req, res, next) => {
        const expected = options.expectedToken
            ?? process.env.PILOTDECK_TIKU_BRIDGE_TOKEN
            ?? process.env.TONGCHENG_COURSEWARE_HANDOFF_TOKEN
            ?? '';
        const bindHost = options.bindHost ?? process.env.HOST ?? '127.0.0.1';
        const allowLocalDevelopment = options.allowLocalDevelopment
            ?? process.env.PILOTDECK_ALLOW_LOCAL_UNAUTHENTICATED_BRIDGE === '1';
        if (!expected) {
            if (allowLocalDevelopment && isLoopbackBindHost(bindHost)) return next();
            return res.status(503).json({
                error: 'Tongcheng courseware bridge token is required for production or non-loopback access',
            });
        }
        const provided = req.headers['x-tongcheng-handoff-token']
            || req.headers['x-pilotdeck-bridge-token']
            || req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (provided !== expected) return res.status(401).json({ error: 'Invalid Tongcheng courseware bridge token' });
        return next();
    };
}

export function registerCoursewareHttpRoutes(app, dependencies) {
    const auth = dependencies.auth || createTongchengBridgeAuth();
    const handlers = createCoursewareHttpHandlers(dependencies);
    app.post('/api/tongcheng/tiku/courseware-slides', auth, handlers.generate);
    app.get('/api/tongcheng/tiku/courseware-slides/status', auth, handlers.status);
    app.post('/api/tongcheng/tiku/courseware-slides/style-approval', auth, handlers.styleApproval);
    app.post('/api/tongcheng/tiku/courseware-slides/patch', auth, handlers.patch);
    return handlers;
}

export function createCoursewareHttpHandlers(dependencies) {
    const {
        safeSlug,
        resolveWorkspaceName,
        resolveGenerationMode,
        listAssetFiles,
        createAssetPackage,
        validateWorkspace,
        writeGenerationRequest,
        writeApprovedStyle,
        getOrchestrator,
        apiPayload,
        buildFallbackSlides,
        writeDerivedFiles,
        buildLegacyStatus,
    } = dependencies;
    const workspaceRoot = () => path.resolve(
        dependencies.workspaceRoot || process.env.TONGCHENG_ASSET_WORKSPACES_ROOT || 'workspaces',
    );

    return {
        generate: asyncHandler(async (req, res) => {
            const tikuContext = req.body?.tikuContext || req.body?.context || req.body?.payload;
            if (!tikuContext || tikuContext.schemaVersion !== 'tiku.courseContext.v1') {
                return res.status(400).json({ error: '需要提供 tiku.courseContext.v1 上下文' });
            }
            const workspaceName = safeSlug(req.body?.workspaceName || resolveWorkspaceName(tikuContext), 'tiku-courseware');
            const projectPath = path.join(workspaceRoot(), workspaceName);
            fs.mkdirSync(projectPath, { recursive: true });
            const generationMode = resolveGenerationMode(
                req.body?.generationMode || tikuContext?.generationRequest?.generationMode,
            );
            const requestedRunId = String(req.body?.runId || '').trim();

            if (requestedRunId) {
                const existingRun = readCoursewareAgentRun(projectPath);
                if (!existingRun || existingRun.runId !== requestedRunId) {
                    return res.status(404).json({ error: '未找到可恢复的课件运行', runId: requestedRunId, workspaceName });
                }
                const result = await getOrchestrator().run({
                    projectPath,
                    runId: requestedRunId,
                    model: req.body?.model,
                    maxOutputTokens: req.body?.maxOutputTokens,
                    maxVisualRepairSlides: req.body?.maxVisualRepairSlides,
                    countResume: true,
                });
                return sendRunResult(res, apiPayload(projectPath, workspaceName, { ...result, resumed: true }));
            }

            const existingPrimaryFiles = listExistingCoursewareFiles(projectPath, COURSEWARE_PRIMARY_FILES);
            const operationMode = resolveCoursewareOperationMode({
                requestedMode: req.body?.operationMode || tikuContext?.generationRequest?.operationMode,
                rebuildMode: tikuContext?.generationRequest?.rebuildMode,
                hasExistingAssets: existingPrimaryFiles.length > 0,
            });
            if (operationMode === 'audit-only' || operationMode === 'reuse-existing') {
                const slidesPackage = readJson(path.join(projectPath, 'courseware-slides.json'));
                if (!Array.isArray(slidesPackage?.slides) || slidesPackage.slides.length === 0) {
                    return res.status(409).json({
                        success: false,
                        code: 'COURSEWARE_EXISTING_ASSET_REQUIRED',
                        error: `${operationMode} 需要已有 courseware-slides.json；当前工作区没有可复用主资产`,
                        operationMode,
                        workspaceName,
                        projectPath,
                    });
                }
                const assetFiles = listAssetFiles(projectPath);
                const packageData = createAssetPackage(workspaceName, projectPath, assetFiles);
                const validation = await validateWorkspace(projectPath, { publishTarget: 'learn' });
                return res.status(validation.ok ? 200 : 422).json({
                    success: validation.ok,
                    runId: null,
                    currentPhase: 'review',
                    status: validation.ok ? 'reviewing' : 'blocked',
                    operationMode,
                    generationMode,
                    engine: 'pilotdeck',
                    degraded: false,
                    reusedExisting: true,
                    workspaceName,
                    workspacePath: projectPath,
                    coursewareSlides: slidesPackage,
                    package: packageData,
                    validation,
                    assetFiles,
                });
            }
            if (operationMode === 'new-asset' && existingPrimaryFiles.length > 0) {
                return res.status(409).json({
                    success: false,
                    code: 'COURSEWARE_ALREADY_EXISTS',
                    error: '当前课次已有主课件；请使用 audit-only/reuse-existing，或由老师显式选择 full-rebuild',
                    operationMode,
                    existingFiles: existingPrimaryFiles,
                });
            }
            if (operationMode === 'incremental-update') {
                return res.status(409).json({
                    success: false,
                    code: 'COURSEWARE_PATCH_SCOPE_REQUIRED',
                    error: '增量修改必须使用 patch 接口提供 allowedWrites、patchScope 和 targetSlideIds',
                });
            }

            const runId = `cw-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
            const snapshot = operationMode === 'full-rebuild'
                ? prepareCoursewareFullRebuild(projectPath, runId)
                : { snapshotPath: null, files: [] };
            fs.writeFileSync(path.join(projectPath, 'tiku-context.json'), `${JSON.stringify(tikuContext, null, 2)}\n`);
            writeGenerationRequest(projectPath, tikuContext);
            const teacherApprovedStyleId = req.body?.teacherApprovedStyleId
                || tikuContext?.generationRequest?.teacherApprovedStyleId
                || null;
            writeCoursewareRunContracts({
                projectPath,
                runId,
                operationMode,
                generationMode,
                teacherApprovedStyleId,
                tikuContext,
                sourceLock: req.body?.sourceLock,
                snapshot,
                outputTargets: req.body?.outputTargets || tikuContext?.generationRequest?.outputTargets,
                audience: req.body?.audience || tikuContext?.generationRequest?.audience,
                budgetLimits: req.body?.budgetLimits || tikuContext?.generationRequest?.budgetLimits,
            });
            writeApprovedStyle(projectPath, {
                runId,
                lessonId: tikuContext?.coursePackage?.lessonId || tikuContext?.lesson?.lessonId,
                teacherApprovedStyleId,
                designTokens: req.body?.designTokens || tikuContext?.generationRequest?.designTokens,
                teacherNotes: req.body?.teacherNotes,
            });

            const pipelinePromise = getOrchestrator().run({
                projectPath,
                runId,
                model: req.body?.model,
                maxOutputTokens: req.body?.maxOutputTokens,
                maxVisualRepairSlides: req.body?.maxVisualRepairSlides,
            });
            const timeoutMs = Math.max(
                dependencies.minimumTimeoutMs ?? 1000,
                Number(req.body?.timeoutMs || process.env.TONGCHENG_COURSEWARE_AGENT_TIMEOUT_MS || 300000),
            );
            const outcome = await Promise.race([
                pipelinePromise.then((result) => ({ result }), (error) => ({ error })),
                new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs)),
            ]);
            if (outcome.timedOut) {
                return res.status(202).json(apiPayload(projectPath, workspaceName, {
                    status: 'running',
                    message: '7-Agent 课件任务仍在运行，可通过状态接口读取真实阶段进度',
                }));
            }
            if (outcome.error) throw outcome.error;
            const result = outcome.result;
            if (result.status === 'blocked' && req.body?.allowTemplateFallback === true && generationMode === 'automatic-draft') {
                const slidesPackage = buildFallbackSlides(tikuContext);
                fs.writeFileSync(path.join(projectPath, 'courseware-slides.json'), `${JSON.stringify(slidesPackage, null, 2)}\n`);
                writeDerivedFiles(projectPath, slidesPackage, tikuContext, { persistSource: false });
                updateCoursewareAgentRun(projectPath, {
                    status: 'draft',
                    degraded: true,
                    degradedReason: 'PilotDeck pipeline was blocked; explicit automatic-draft template fallback was requested.',
                    publish: { allowed: false, reason: 'Degraded template draft requires teacher review.' },
                });
                return res.status(200).json(apiPayload(projectPath, workspaceName, {
                    mode: 'template-fallback',
                    status: 'draft',
                    degraded: true,
                }));
            }
            return sendRunResult(res, apiPayload(projectPath, workspaceName, result));
        }),

        status: asyncHandler(async (req, res) => {
            const workspaceName = safeSlug(req.query.workspaceName || req.query.workspace || '', '');
            if (!workspaceName) return res.status(400).json({ error: '缺少 workspaceName' });
            const projectPath = path.join(workspaceRoot(), workspaceName);
            if (!fs.existsSync(projectPath)) return res.status(404).json({ error: '未找到教研创作工作区' });
            const run = readCoursewareAgentRun(projectPath);
            if (!run) return res.json(buildLegacyStatus(projectPath, { workspaceName, sessionKey: String(req.query.sessionKey || '') }));
            return sendRunResult(res, apiPayload(projectPath, workspaceName));
        }),

        styleApproval: asyncHandler(async (req, res) => {
            const { workspaceName, projectPath } = resolveRequestWorkspace(req.body, safeSlug, workspaceRoot());
            const result = await getOrchestrator().approveStyle({
                projectPath,
                runId: String(req.body?.runId || ''),
                styleId: req.body?.styleId,
                teacherNotes: req.body?.teacherNotes,
                model: req.body?.model,
            });
            return sendRunResult(res, apiPayload(projectPath, workspaceName, result));
        }),

        patch: asyncHandler(async (req, res) => {
            const { workspaceName, projectPath } = resolveRequestWorkspace(req.body, safeSlug, workspaceRoot());
            const result = await getOrchestrator().patchSlides({
                projectPath,
                runId: String(req.body?.runId || ''),
                patchScope: req.body?.patchScope,
                allowedWrites: req.body?.allowedWrites,
                targetSlideIds: req.body?.targetSlideIds,
                model: req.body?.model,
            });
            return sendRunResult(res, apiPayload(projectPath, workspaceName, result));
        }),
    };
}

function resolveRequestWorkspace(body, safeSlug, root) {
    const workspaceName = safeSlug(body?.workspaceName || '', '');
    if (!workspaceName) throw Object.assign(new Error('缺少 workspaceName'), { statusCode: 400 });
    return { workspaceName, projectPath: path.join(root, workspaceName) };
}

function sendRunResult(res, payload) {
    const statusCode = payload.status === 'running'
        ? 202
        : ['blocked', 'failed'].includes(payload.status) ? 422 : 200;
    return res.status(statusCode).json(payload);
}

function asyncHandler(handler) {
    return async (req, res) => {
        try {
            return await handler(req, res);
        } catch (error) {
            return res.status(error?.statusCode || 500).json({ error: error instanceof Error ? error.message : String(error) });
        }
    };
}

function readJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function isLoopbackBindHost(value) {
    const host = String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}
