#!/usr/bin/env node
// Load environment variables before other imports execute
import { assertRequiredPilotDeckEnv } from './load-env.js';
// Install global fetch proxy (PILOTDECK_PROXY / HTTPS_PROXY) before any network calls
import { installGlobalProxy } from './utils/proxy.js';
installGlobalProxy();

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const installMode = fs.existsSync(path.join(__dirname, '..', '..', '.git')) ? 'git' : 'npm';

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    ok: (text) => `${colors.green}${text}${colors.reset}`,
    warn: (text) => `${colors.yellow}${text}${colors.reset}`,
    tip: (text) => `${colors.blue}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

assertRequiredPilotDeckEnv();
console.log('SERVER_PORT from runtime config:', process.env.SERVER_PORT);

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import os from 'os';
import http from 'http';
import cors from 'cors';
import { promises as fsPromises } from 'fs';
import { spawn, exec } from 'child_process';
import pty from 'node-pty';
import fetch from 'node-fetch';
import mime from 'mime-types';
import JSZip from 'jszip';
import { readPermissionSettings } from './services/permissionSettings.js';
import { readPilotDeckConfigFile } from './services/pilotdeckConfig.js';

import { getProjects, getProjectCronJobsOverview, getSessions, renameProject, deleteSession, deleteProject, addProjectManually, extractProjectDirectory, clearProjectDirectoryCache, searchConversations } from './projects.js';
import {
    runChatViaGateway,
    abortViaGateway,
    decidePermissionViaGateway,
    grantSessionPermissionViaGateway,
    isSessionActiveViaGateway,
    getActiveTurnSnapshotFramesViaGateway,
    getActiveSessionIdsViaGateway,
    elicitationRespondViaGateway,
    getRouterDashboardData,
    getRouterSessionStats,
    getRouterStatsSummary,
    getPilotDeckGateway,
    registerAlwaysOnNotificationForwarding,
    getSessionTokenBudget,
} from './pilotdeck-bridge.js';
import sessionManager from './sessionManager.js';
import gitRoutes from './routes/git.js';
import authRoutes from './routes/auth.js';
import mcpRoutes from './routes/mcp.js';
import taskmasterRoutes from './routes/taskmaster.js';
import memoryRoutes, { MEMORY_DASHBOARD_DIR } from './routes/memory.js';
import mcpUtilsRoutes from './routes/mcp-utils.js';
import commandsRoutes from './routes/commands.js';
import skillsRoutes from './routes/skills.js';
import settingsRoutes from './routes/settings.js';
import configRoutes from './routes/config.js';
import gatewayRoutes from './routes/gateway.js';
import { startPilotDeckConfigWatcher, stopPilotDeckConfigWatcher } from './services/pilotdeckConfigWatcher.js';
import { getAlwaysOnDashboardEvents } from './services/always-on-events.js';
import agentRoutes from './routes/agent.js';
import updateRoutes from './routes/update.js';
import projectsRoutes, { WORKSPACES_ROOT, validateWorkspacePath } from './routes/projects.js';
import userRoutes from './routes/user.js';
import pluginsRoutes from './routes/plugins.js';
import messagesRoutes from './routes/messages.js';
import { closeMemoryServices, startMemoryScheduler, stopMemoryScheduler } from './services/memoryService.js';
import { createNormalizedMessage } from './pilotdeck-message.js';
import { startEnabledPluginServers, stopAllPlugins, getPluginPort } from './utils/plugin-process-manager.js';
import { initializeDatabase, sessionNamesDb, applyCustomSessionNames, userDb } from './database/db.js';
import { configureWebPush } from './services/vapid-keys.js';
import { sendCronDaemonRequest } from './services/cron-daemon-owner.js';
import { createAlwaysOnHeartbeatManager } from './always-on-heartbeat.js';

import { runServerStartupBeforeListen, startServerAfterStartup } from './services/server-startup.js';
import { validateApiKey, authenticateToken, authenticateWebSocket } from './middleware/auth.js';
import { DISABLE_LOCAL_AUTH, IS_PLATFORM } from './constants/config.js';
import { getConnectableHost } from '../shared/networkHosts.js';
import { contentDispositionAttachment } from './utils/downloadHeaders.js';
import {
    COURSEWARE_PRIMARY_FILES,
    listExistingCoursewareFiles,
    prepareCoursewareFullRebuild,
    resolveCoursewareOperationMode,
    updateCoursewareAgentRun,
    writeCoursewareRunContracts,
} from './courseware-run-policy.js';
import { createGatewayCoursewareAgentRunner } from './courseware-agent-runner.js';
import { createCoursewareAgentOrchestrator } from './courseware-agent-orchestrator.js';
import { readCoursewareAgentRun, summarizeCoursewareAgentRun } from './courseware-agent-state.js';
import { exportPilotDeckPdf, exportPilotDeckPptx } from './courseware-derived-assets.js';
import { createTongchengBridgeAuth, registerCoursewareHttpRoutes } from './courseware-http-routes.js';
import { createOpenMaicCoursewareLaunchUrl } from './openmaic-courseware-handoff.js';
import { readCoursewareDeliveryAssets } from './courseware-delivery-assets.js';

// PilotDeck-only mode: chat execution always goes through src/gateway via
// cursor-cli, openai-codex, gemini-cli) has been removed.
const VALID_PROVIDERS = ['pilotdeck'];

// File-system watchers for the chat transcript root maintained by
// PilotDeck. Provider-specific watchers (.pilotdeck) were dropped along with the four provider adapters.
// .gemini) were dropped along with the four provider adapters.
const PROVIDER_WATCH_PATHS = [
    {
        provider: 'pilotdeck',
        rootPath: path.join(
            process.env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck'),
            'projects',
        ),
    },
];
const WATCHER_IGNORED_PATTERNS = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/*.tmp',
    '**/*.swp',
    '**/.DS_Store'
];
const WATCHER_DEBOUNCE_MS = 300;
let projectsWatchers = [];
let projectsWatcherDebounceTimer = null;
const connectedClients = new Set();
const alwaysOnHeartbeat = createAlwaysOnHeartbeatManager({
    // Legacy four-provider session details have been removed; PilotDeck
    // gateway sessions are tracked by `pilotdeck-bridge.js` instead.
    getActivePilotDeckSessions: () => []
});
registerAlwaysOnNotificationForwarding(connectedClients);
let isGetProjectsRunning = false; // Flag to prevent reentrant calls

// Broadcast progress to all connected WebSocket clients
function broadcastProgress(progress) {
    const message = JSON.stringify({
        type: 'loading_progress',
        ...progress
    });
    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Broadcasts ~/.pilotdeck/pilotdeck.yaml reload events (from UI saves or external file edits)
// to every connected WebSocket client so open Settings tabs refresh instantly.
function broadcastConfigReloaded(payload) {
    const message = JSON.stringify({ type: 'config:reloaded', ...payload });
    connectedClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}
process.on('pilotdeck:config-broadcast', broadcastConfigReloaded);


async function setupProjectsWatcher() {
    const chokidar = (await import('chokidar')).default;

    if (projectsWatcherDebounceTimer) {
        clearTimeout(projectsWatcherDebounceTimer);
        projectsWatcherDebounceTimer = null;
    }

    await Promise.all(
        projectsWatchers.map(async (watcher) => {
            try {
                await watcher.close();
            } catch (error) {
                console.error('[WARN] Failed to close watcher:', error);
            }
        })
    );
    projectsWatchers = [];

    const debouncedUpdate = (eventType, filePath, provider, rootPath) => {
        if (projectsWatcherDebounceTimer) {
            clearTimeout(projectsWatcherDebounceTimer);
        }

        projectsWatcherDebounceTimer = setTimeout(async () => {
            // Prevent reentrant calls
            if (isGetProjectsRunning) {
                return;
            }

            try {
                isGetProjectsRunning = true;

                // Clear project directory cache when files change
                clearProjectDirectoryCache();

                // Get updated projects list
                const updatedProjects = await getProjects(broadcastProgress);

                // Notify all connected clients about the project changes
                const updateMessage = JSON.stringify({
                    type: 'projects_updated',
                    projects: updatedProjects,
                    timestamp: new Date().toISOString(),
                    changeType: eventType,
                    changedFile: path.relative(rootPath, filePath),
                    watchProvider: provider
                });

                connectedClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(updateMessage);
                    }
                });

            } catch (error) {
                console.error('[ERROR] Error handling project changes:', error);
            } finally {
                isGetProjectsRunning = false;
            }
        }, WATCHER_DEBOUNCE_MS);
    };

    for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
        try {
            // chokidar v4 emits ENOENT via the "error" event for missing roots and will not auto-recover.
            // Ensure provider folders exist before creating the watcher so watching stays active.
            await fsPromises.mkdir(rootPath, { recursive: true });

            // Initialize chokidar watcher with optimized settings
            const watcher = chokidar.watch(rootPath, {
                ignored: WATCHER_IGNORED_PATTERNS,
                persistent: true,
                ignoreInitial: true, // Don't fire events for existing files on startup
                followSymlinks: false,
                depth: 10, // Reasonable depth limit
                awaitWriteFinish: {
                    stabilityThreshold: 100, // Wait 100ms for file to stabilize
                    pollInterval: 50
                }
            });

            // Set up event listeners
            watcher
                .on('add', (filePath) => debouncedUpdate('add', filePath, provider, rootPath))
                .on('change', (filePath) => debouncedUpdate('change', filePath, provider, rootPath))
                .on('unlink', (filePath) => debouncedUpdate('unlink', filePath, provider, rootPath))
                .on('addDir', (dirPath) => debouncedUpdate('addDir', dirPath, provider, rootPath))
                .on('unlinkDir', (dirPath) => debouncedUpdate('unlinkDir', dirPath, provider, rootPath))
                .on('error', (error) => {
                    console.error(`[ERROR] ${provider} watcher error:`, error);
                })
                .on('ready', () => {
                });

            projectsWatchers.push(watcher);
        } catch (error) {
            console.error(`[ERROR] Failed to setup ${provider} watcher for ${rootPath}:`, error);
        }
    }

    if (projectsWatchers.length === 0) {
        console.error('[ERROR] Failed to setup any provider watchers');
    }
}


const app = express();
const server = http.createServer(app);

const ptySessionsMap = new Map();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const TRAILING_URL_PUNCTUATION_REGEX = /[)\]}>.,;:!?]+$/;

function stripAnsiSequences(value = '') {
    return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '');
}

function normalizeDetectedUrl(url) {
    if (!url || typeof url !== 'string') return null;

    const cleaned = url.trim().replace(TRAILING_URL_PUNCTUATION_REGEX, '');
    if (!cleaned) return null;

    try {
        const parsed = new URL(cleaned);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

function extractUrlsFromText(value = '') {
    const directMatches = value.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/gi) || [];

    // Handle wrapped terminal URLs split across lines by terminal width.
    const wrappedMatches = [];
    const continuationRegex = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
    const lines = value.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const startMatch = line.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/i);
        if (!startMatch) continue;

        let combined = startMatch[0];
        let j = i + 1;
        while (j < lines.length) {
            const continuation = lines[j].trim();
            if (!continuation) break;
            if (!continuationRegex.test(continuation)) break;
            combined += continuation;
            j++;
        }

        wrappedMatches.push(combined.replace(/\r?\n\s*/g, ''));
    }

    return Array.from(new Set([...directMatches, ...wrappedMatches]));
}

function shouldAutoOpenUrlFromOutput(value = '') {
    const normalized = value.toLowerCase();
    return (
        normalized.includes('browser didn\'t open') ||
        normalized.includes('open this url') ||
        normalized.includes('continue in your browser') ||
        normalized.includes('press enter to open') ||
        normalized.includes('open_url:')
    );
}

// Single WebSocket server that handles both paths
const wss = new WebSocketServer({
    server,
    verifyClient: (info) => {
        console.log('WebSocket connection attempt to:', info.req.url);

        // Platform / no-login mode: allow connection without token
        if (IS_PLATFORM || DISABLE_LOCAL_AUTH) {
            const user = authenticateWebSocket(null); // Returns first DB user
            if (!user) {
                console.log('[WARN] WebSocket auth bypass: No user found in database');
                return false;
            }
            info.req.user = user;
            console.log('[OK] WebSocket authenticated (bypass) for user:', user.username);
            return true;
        }

        // Normal mode: verify token
        // Extract token from query parameters or headers
        const url = new URL(info.req.url, 'http://localhost');
        const token = url.searchParams.get('token') ||
            info.req.headers.authorization?.split(' ')[1];

        // Verify token
        const user = authenticateWebSocket(token);
        if (!user) {
            console.log('[WARN] WebSocket authentication failed');
            return false;
        }

        // Store user info in the request for later use
        info.req.user = user;
        console.log('[OK] WebSocket authenticated for user:', user.username);
        return true;
    }
});

// Make WebSocket server available to routes
app.locals.wss = wss;

app.use(cors({ exposedHeaders: ['X-Refreshed-Token'] }));
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode
    });
});

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// MCP API Routes (protected)
app.use('/api/mcp', authenticateToken, mcpRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);

// Memory API Routes (protected)
app.use('/api/memory', authenticateToken, memoryRoutes);

// MCP utilities
app.use('/api/mcp-utils', authenticateToken, mcpUtilsRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Skills API Routes (protected) — list/edit/install skills surfaced in the
// top-right Skills tab. Backed by ~/.pilotdeck/skills/ and project-level
// .pilotdeck/skills/ via PilotDeck plugin runtime.
app.use('/api/skills', authenticateToken, skillsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

// PilotDeck unified YAML config routes (protected)
app.use('/api/config', authenticateToken, configRoutes);

// Gateway IM channel setup routes (protected)
app.use('/api/gateway', authenticateToken, gatewayRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Plugins API Routes (protected)
app.use('/api/plugins', authenticateToken, pluginsRoutes);

// Unified session messages route (protected) — PilotDeck-only.
app.use('/api/sessions', authenticateToken, messagesRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

// Self-update API Routes (protected)
app.use('/api/update', authenticateToken, updateRoutes);

// Legacy four-provider config endpoints have been removed. The runtime
// model is read from PilotDeck config; fall back to a static stub so any
// older frontend code paths render without crashing.
app.get('/api/agents/runtime-config', authenticateToken, (_req, res) => {
    const permSettings = readPermissionSettings();
    let availableModels = [];
    let defaultModel = '';
    try {
        const record = readPilotDeckConfigFile();
        if (typeof record.config?.agent?.model === 'string') {
            defaultModel = record.config.agent.model.trim();
        }
        const unavailableModelIds = new Set(
            String(process.env.TONGCHENG_DISABLED_MODELS || 'tc-premium,tc-coding')
                .split(',')
                .map((modelId) => modelId.trim())
                .filter(Boolean),
        );
        const providers = record.config?.model?.providers;
        if (providers && typeof providers === 'object') {
            const defaultProviderId = defaultModel.includes('/') ? defaultModel.split('/')[0] : '';
            const preferredProviders = new Set([
                defaultProviderId,
                'tc-admin',
            ].filter(Boolean));
            const byModelId = new Map();
            for (const [providerId, provider] of Object.entries(providers)) {
                const models = provider?.models;
                if (!models || typeof models !== 'object') continue;
                for (const [modelId, modelDef] of Object.entries(models)) {
                    if (unavailableModelIds.has(modelId)) continue;
                    const value = `${providerId}/${modelId}`;
                    const option = {
                        value,
                        label: modelDef?.displayName || modelId,
                    };
                    const current = byModelId.get(modelId);
                    if (!current || preferredProviders.has(providerId)) {
                        byModelId.set(modelId, option);
                    }
                }
            }
            availableModels = Array.from(byModelId.values()).sort((left, right) => {
                const order = ['tc-main', 'tc-multimodal', 'tc-economy', 'tc-local'];
                const leftId = left.value.split('/').pop();
                const rightId = right.value.split('/').pop();
                const leftIndex = order.indexOf(leftId);
                const rightIndex = order.indexOf(rightId);
                if (leftIndex !== -1 || rightIndex !== -1) {
                    return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
                }
                return left.label.localeCompare(right.label);
            });
        }
    } catch (error) {
        console.warn('[runtime-config] failed to read PilotDeck model config:', error?.message || error);
    }

    res.json({
        pilotdeck: { provider: 'pilotdeck' },
        claude: {
            defaultModel,
            availableModels,
        },
        permissions: {
            skipPermissions: permSettings.skipPermissions,
            effectiveMode: permSettings.skipPermissions ? 'bypassPermissions' : 'default',
        },
    });
});

// Provider-specific endpoints removed by the PilotDeck-only migration.
// Returning a structured error keeps any stragglers in the UI from
// hanging on an unanswered fetch.
const PROVIDER_REMOVED_PATHS = ['/api/cursor', '/api/codex', '/api/gemini', '/api/cli'];
for (const removedPrefix of PROVIDER_REMOVED_PATHS) {
    app.use(removedPrefix, (_req, res) => {
        res.status(410).json({
            error: 'endpoint_removed',
            message: `Provider endpoint ${removedPrefix} was removed during the PilotDeck-only migration.`,
        });
    });
}

// PilotDeck routing dashboard. The `/api/ccr/*` URL family was kept for
// frontend back-compat (Dashboard tab + useRouterSettings) but the data
// now comes from `src/router/stats/TokenStatsCollector` via the

app.get('/api/ccr/dashboard', authenticateToken, (_req, res) => {
    try {
        res.json(getRouterDashboardData());
    } catch (error) {
        console.error('[router-dashboard] failed:', error);
        res.status(500).json({ error: error?.message || 'router-dashboard failed' });
    }
});

app.get('/api/always-on/events', authenticateToken, async (req, res) => {
    try {
        const limit = Number.parseInt(req.query?.limit || '', 10);
        const since = req.query?.since || undefined;
        const result = await getAlwaysOnDashboardEvents({
            limit: Number.isFinite(limit) ? limit : 200,
            since: typeof since === 'string' ? since : undefined,
        });
        res.json(result);
    } catch (error) {
        console.error('[always-on-events] failed:', error);
        res.status(500).json({ error: error?.message || 'always-on-events failed' });
    }
});

app.get('/api/always-on/cron-jobs', authenticateToken, async (_req, res) => {
    try {
        const result = await getProjectCronJobsOverview();
        res.json(result);
    } catch (error) {
        console.error('[always-on-cron-jobs] failed:', error);
        res.status(500).json({ error: error?.message || 'always-on-cron-jobs failed' });
    }
});

app.post('/api/always-on/cron-jobs/:taskId/run-now', authenticateToken, async (req, res) => {
    try {
        const gateway = await getPilotDeckGateway();
        const result = await gateway.cronRunNow({ taskId: req.params.taskId });
        res.json(result);
    } catch (error) {
        console.error('[always-on-cron-run-now] failed:', error);
        res.status(500).json({ error: error?.message || 'cron run-now failed' });
    }
});

app.post('/api/always-on/cron-jobs/:taskId/stop', authenticateToken, async (req, res) => {
    try {
        const gateway = await getPilotDeckGateway();
        const result = await gateway.cronStop({ taskId: req.params.taskId });
        res.json(result);
    } catch (error) {
        console.error('[always-on-cron-stop] failed:', error);
        res.status(500).json({ error: error?.message || 'cron stop failed' });
    }
});

app.delete('/api/always-on/cron-jobs/:taskId', authenticateToken, async (req, res) => {
    try {
        const gateway = await getPilotDeckGateway();
        const result = await gateway.cronDelete({ taskId: req.params.taskId, stopRunning: true });
        res.json(result);
    } catch (error) {
        console.error('[always-on-cron-delete] failed:', error);
        res.status(500).json({ error: error?.message || 'cron delete failed' });
    }
});

app.get('/api/ccr/health', authenticateToken, (_req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        port: null,
        embedded: true,
        backend: 'pilotdeck-router',
    });
});

app.get('/api/ccr/config', authenticateToken, (_req, res) => {
    // The legacy CCR YAML schema is no longer the source of truth for
    // model routing — that lives in PilotDeck config now. Return null so
    // the legacy useRouterSettings hook simply renders the "no config"
    // empty state instead of a config editor.
    res.json(null);
});

app.get('/api/ccr/stats/summary', authenticateToken, (_req, res) => {
    try {
        res.json(getRouterStatsSummary());
    } catch (error) {
        res.status(500).json({ error: error?.message || 'router-stats-summary failed' });
    }
});

app.get('/api/ccr/stats/sessions/:sessionId', authenticateToken, (req, res) => {
    try {
        const stats = getRouterSessionStats(req.params.sessionId);
        if (!stats) {
            return res.status(404).json({ error: 'session_not_found' });
        }
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error?.message || 'router-stats-session failed' });
    }
});

app.post('/api/ccr/stats/reset', authenticateToken, (_req, res) => {
    // Reset would require reaching into per-project TokenStatsCollector
    // instances; that is not exposed today. Surface a clear hint instead
    // of silently no-oping.
    res.status(501).json({
        error: 'not_implemented',
        message: 'Per-project router stats reset is not exposed yet; restart the PilotDeck server to clear in-memory state.',
    });
});

app.put('/api/ccr/config', authenticateToken, (_req, res) => {
    res.status(501).json({
        error: 'not_implemented',
        message: 'Routing configuration is owned by PilotDeck config (~/.pilotdeck/pilotdeck.yaml). Edit it directly via /api/config.',
    });
});

app.get('/memory-dashboard', authenticateToken, (req, res) => {
    const indexPath = path.join(MEMORY_DASHBOARD_DIR, 'index.html');
    if (!fs.existsSync(indexPath)) {
        res.status(404).type('text/plain').send('Memory dashboard assets not bundled.');
        return;
    }
    res.sendFile(indexPath);
});

app.use('/memory-dashboard', authenticateToken, express.static(MEMORY_DASHBOARD_DIR, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Hard 404 boundary: anything still asking for /memory-dashboard/* after the
// static middleware is a missing asset. Without this, the request would fall
// through to the SPA wildcard below and return the PilotDeck shell index.html,
// which the MemoryPanel iframe then renders — recursively nesting the entire
// app inside itself (see bug: "嵌套显示 + general memory 多次出现").
app.use('/memory-dashboard', (_req, res) => {
    res.status(404).type('text/plain').send('Not found in memory-dashboard.');
});

// Serve public files (like api-docs.html)
app.use(express.static(path.join(__dirname, '../public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(__dirname, '../dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs.
// /api/system/update was the V1 "Update available" banner backend; the
// VersionUpgradeModal that consumed it was removed during the V1 cleanup.

app.get('/api/projects', authenticateToken, async (req, res) => {
    try {
        const projects = await getProjects(broadcastProgress);
        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:projectName/sessions', authenticateToken, async (req, res) => {
    try {
        const { limit = 5, offset = 0 } = req.query;
        const result = await getSessions(req.params.projectName, parseInt(limit), parseInt(offset));
        applyCustomSessionNames(result.sessions, 'pilotdeck');
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function resolveCoursewareSubjectFromAssets(projectPath) {
    const text = fs.existsSync(path.join(projectPath, 'brief.md'))
        ? fs.readFileSync(path.join(projectPath, 'brief.md'), 'utf8')
        : '';
    if (/GESP|CSP|C\+\+|编程|算法|代码|程序/.test(text)) return 'cpp';
    if (/数学|方程|几何|代数|函数|数列/.test(text)) return 'math';
    if (/语文|文言文|古诗|阅读|作文|句读|赏析/.test(text)) return 'chinese';
    if (/英语|English|词汇|语法|句型|听力|口语/.test(text)) return 'english';
    if (/物理|力学|电路|光学|压强|浮力/.test(text)) return 'physics';
    if (/化学|反应|方程式|实验|元素|溶液/.test(text)) return 'chemistry';
    if (/AI|人工智能|机器学习|大模型/.test(text)) return 'ai';
    return 'cpp';
}

function listCoursewareAssetFiles(projectPath) {
    const expected = [
        'brief.md',
        'tiku-context.json',
        'course-outline.md',
        'teacher-script.md',
        'exercises.md',
        'pitfalls.md',
        'parent-feedback.md',
        'homework.md',
        'oj-exercises.md',
        'edu-exercises.md',
        'ppt-outline.md',
        'learn-integration.md',
        'learn整合方案.md',
        'course-feedback.md',
        'teacher-feedback.md',
        'courseware-slides.json',
        'courseware.html',
        'index.html',
        'teach-courseware.html',
        'deck.html',
        'slides.html',
        'courseware.pptx',
        'deck.pptx',
        'slides.pptx',
        'slides-manifest.json',
        'courseware-package.json',
        'generator-handoff.json',
        'video-script.md',
        'complete-course-package.md',
    ];
    const files = expected.filter((fileName) => fs.existsSync(path.join(projectPath, fileName)));
    const nestedHtmlCandidates = [
        'index.html',
        'deck.html',
        'slides.html',
        'courseware.html',
        'teach-courseware.html',
    ];
    const ignoredDirs = new Set(['node_modules', '.git', '.next', 'dist', 'build']);
    function scan(dir, depth = 0) {
        if (depth > 3) return;
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || ignoredDirs.has(entry.name)) continue;
            const absolute = path.join(dir, entry.name);
            const relative = path.relative(projectPath, absolute).split(path.sep).join('/');
            if (entry.isDirectory()) {
                scan(absolute, depth + 1);
                continue;
            }
            if (depth > 0 && nestedHtmlCandidates.includes(entry.name) && !files.includes(relative)) {
                files.push(relative);
            }
            if (entry.name === 'slides-manifest.json' && !files.includes(relative)) {
                files.push(relative);
            }
            if (entry.name === 'courseware-slides.json' && !files.includes(relative)) {
                files.push(relative);
            }
            if (['courseware-package.json', 'generator-handoff.json'].includes(entry.name) && !files.includes(relative)) {
                files.push(relative);
            }
            if (entry.name.endsWith('.pptx') && !files.includes(relative)) {
                files.push(relative);
            }
            if (/learn.*整合.*\.md$/i.test(entry.name) && !files.includes(relative)) {
                files.push(relative);
            }
        }
    }
    scan(projectPath);
    return files;
}

function readCoursewareAssetText(projectPath, fileName) {
    const filePath = path.join(projectPath, fileName);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

let tongchengCoursewareValidatorPromise = null;

async function loadTongchengCoursewareValidator() {
    if (tongchengCoursewareValidatorPromise) return tongchengCoursewareValidatorPromise;
    const defaultValidatorPath = path.resolve(__dirname, '..', '..', '..', 'AI-practice', 'lib', 'courseware-validator', 'index.js');
    const validatorPath = path.resolve(process.env.TIKU_COURSEWARE_VALIDATOR || defaultValidatorPath);
    tongchengCoursewareValidatorPromise = (async () => {
        if (!fs.existsSync(validatorPath)) {
            return {
                missing: true,
                validatorPath,
                validateCourseware: () => ({
                    ok: false,
                    issues: [{
                        code: 'validator.missing',
                        message: `未找到共享课件校验器：${validatorPath}`,
                    }],
                    warnings: [],
                    checks: [{
                        status: 'failed',
                        code: 'validator.missing',
                        message: `未找到共享课件校验器：${validatorPath}`,
                    }],
                    stats: {},
                }),
            };
        }
        return {
            missing: false,
            validatorPath,
            ...(await import(pathToFileURL(validatorPath).href)),
        };
    })();
    return tongchengCoursewareValidatorPromise;
}

async function validateTongchengCoursewareWorkspace(projectPath, options = {}) {
    const validator = await loadTongchengCoursewareValidator();
    const result = validator.validateCourseware({
        workspacePath: projectPath,
        publishTarget: options.publishTarget || 'learn',
    }, {
        publishTarget: options.publishTarget || 'learn',
    });
    const reportPath = path.join(projectPath, 'courseware-agent-report.json');
    const existingReport = readJsonFileIfExists(reportPath) || {};
    fs.writeFileSync(reportPath, JSON.stringify({
        ...existingReport,
        validator: {
            name: 'tiku-courseware-validator',
            source: validator.validatorPath,
            missing: Boolean(validator.missing),
            checkedAt: new Date().toISOString(),
            ok: result.ok,
            issues: result.issues,
            warnings: result.warnings,
            checks: result.checks,
            stats: result.stats,
        },
        blockers: [
            ...(Array.isArray(existingReport.blockers) ? existingReport.blockers : []),
            ...result.issues.map((item) => item.message),
        ],
        checks: [
            ...(Array.isArray(existingReport.checks) ? existingReport.checks : []),
            ...(result.checks || []).map((item) => ({
                name: item.code,
                status: item.status,
                detail: item.message,
            })),
        ],
        updatedAt: new Date().toISOString(),
    }, null, 2));
    if (!result.ok) {
        const error = new Error(`课件质量校验未通过：${result.issues.map((item) => item.message).slice(0, 3).join('；')}`);
        error.statusCode = 422;
        error.validation = result;
        throw error;
    }
    return result;
}

function compactCoursewareTitle(text, fallback) {
    const heading = String(text || '').match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (heading) return heading;
    const firstLine = String(text || '')
        .split('\n')
        .map((line) => line.replace(/^[-*#>\s]+/, '').trim())
        .find(Boolean);
    return firstLine || fallback;
}

function firstExistingCoursewareAsset(assetFiles, candidates) {
    return candidates.find((fileName) => assetFiles.includes(fileName));
}

const COURSEWARE_STUDENT_FORBIDDEN_TERMS = [
    '江校',
    'agent',
    'Pilot',
    'OpenMAIC',
    '内部',
    '验收',
    '落库',
    'metadata',
    'courseware_jobs',
    '老师讲稿',
];

function stripHtmlTags(value) {
    return String(value || '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeCoursewareStudentHtml(value) {
    let html = String(value || '');
    html = html
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
        .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
        .replace(/\s+(href|src)\s*=\s*"javascript:[^"]*"/gi, '')
        .replace(/\s+(href|src)\s*=\s*'javascript:[^']*'/gi, '');
    for (const term of COURSEWARE_STUDENT_FORBIDDEN_TERMS) {
        html = html.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
    }
    return html.trim();
}

function cleanCoursewareStudentText(value) {
    let text = String(value || '')
        .split(/\r?\n/)
        .filter((line) => !COURSEWARE_STUDENT_FORBIDDEN_TERMS.some((term) => line.includes(term)))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    for (const term of COURSEWARE_STUDENT_FORBIDDEN_TERMS) {
        text = text.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
    }
    return text.trim();
}

function coursewareMarkdownToHtml(markdown) {
    const text = cleanCoursewareStudentText(markdown);
    if (!text) return '<p>本页内容待补充。</p>';
    return text
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => {
            const lines = block.split(/\n/).map((line) => line.trim()).filter(Boolean);
            if (lines.length > 1 || lines.every((line) => /^[-*•]\s+/.test(line))) {
                const items = lines.map((line) => line.replace(/^[-*•]\s+/, '')).filter(Boolean);
                return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
            }
            return `<p>${escapeHtml(block)}</p>`;
        })
        .join('\n');
}

function makeCoursewareSlideHtml({ title, kicker, markdown, type }) {
    const html = [
        `<section class="tc-slide tc-slide-${escapeHtml(type)}">`,
        `  <div class="tc-slide-kicker">${escapeHtml(kicker || '课堂课件')}</div>`,
        `  <h2>${escapeHtml(title)}</h2>`,
        '  <div class="tc-slide-body">',
        coursewareMarkdownToHtml(markdown),
        '  </div>',
        '</section>',
    ].join('\n');
    return sanitizeCoursewareStudentHtml(html);
}

function normalizeTikuContextQuestion(question, source = 'tiku') {
    return {
        source: question?.source || source,
        question_id: question?.question_id || question?.id || '',
        knowledge_id: question?.knowledge_id || '',
        content: cleanCoursewareStudentText(question?.content || question?.title || ''),
        type: question?.type || 'short_answer',
        difficulty: question?.difficulty,
        answer: question?.answer || question?.correct_option || '',
        explanation: question?.explanation || question?.analysis || '',
    };
}

function buildCoursewareSlidesFromTikuContext(tikuContext) {
    const coursePackage = tikuContext?.coursePackage || {};
    const lesson = tikuContext?.lesson || {};
    const knowledge = tikuContext?.knowledge || {};
    const title = cleanCoursewareStudentText(
        lesson.title ||
        coursePackage.lessonTitle ||
        coursePackage.title ||
        '课堂课件',
    );
    const knowledgeNames = [
        ...(Array.isArray(knowledge.selectedNodes) ? knowledge.selectedNodes.map((node) => node?.name) : []),
        ...(Array.isArray(knowledge.descendantNodes) ? knowledge.descendantNodes.slice(0, 5).map((node) => node?.name) : []),
    ].filter(Boolean);
    const materials = Array.isArray(tikuContext?.materials) ? tikuContext.materials : [];
    const questions = [
        ...(Array.isArray(tikuContext?.questions) ? tikuContext.questions.map((item) => normalizeTikuContextQuestion(item, 'tiku')) : []),
        ...(Array.isArray(tikuContext?.aiDraftQuestions) ? tikuContext.aiDraftQuestions.map((item) => normalizeTikuContextQuestion(item, 'ai-draft')) : []),
    ].filter((item) => item.content);
    const duration = Number(coursePackage.durationMinutes || lesson.durationMinutes || 180);
    const slides = [];
    const push = ({ type, title: slideTitle, markdown, notes = '', durationMinutes = 8 }) => {
        const order = slides.length + 1;
        const normalizedType = normalizeCoursewareSlideType(type, order);
        const safeTitle = cleanCoursewareStudentText(slideTitle || `第 ${order} 页`);
        const safeMarkdown = cleanCoursewareStudentText(markdown);
        slides.push({
            id: `slide-${String(order).padStart(2, '0')}`,
            order,
            type: normalizedType,
            title: safeTitle,
            html: makeCoursewareSlideHtml({
                title: safeTitle,
                kicker: normalizedType === 'cover' ? '课程导入' : normalizedType === 'practice' ? '课堂练习' : '核心讲解',
                markdown: safeMarkdown,
                type: normalizedType,
            }),
            markdown: safeMarkdown,
            notes: cleanCoursewareStudentText(notes),
            duration_minutes: durationMinutes,
            student_visible: true,
        });
    };

    push({
        type: 'cover',
        title,
        markdown: [
            `本节课目标：围绕「${title}」建立解题路径。`,
            knowledgeNames.length ? `核心知识点：${knowledgeNames.slice(0, 4).join('、')}。` : '',
            `建议时长：${duration} 分钟。`,
        ].filter(Boolean).join('\n\n'),
        durationMinutes: 6,
    });

    push({
        type: 'concept',
        title: '知识地图',
        markdown: knowledgeNames.length
            ? knowledgeNames.slice(0, 8).map((name, index) => `${index + 1}. ${name}`).join('\n')
            : '先明确本课核心概念，再用例题验证理解。',
        durationMinutes: 10,
    });

    const materialText = materials
        .slice(0, 3)
        .map((item, index) => `${index + 1}. ${cleanCoursewareStudentText(item.content || '')}`)
        .filter(Boolean)
        .join('\n');
    push({
        type: 'concept',
        title: '讲解素材',
        markdown: materialText || '用一个典型问题导入，先读题，再圈出输入、处理和输出。',
        durationMinutes: 12,
    });

    questions.slice(0, 4).forEach((question, index) => {
        push({
            type: index < 2 ? 'example' : 'practice',
            title: index < 2 ? `例题 ${index + 1}` : `课堂练习 ${index - 1}`,
            markdown: [
                question.content,
                question.answer ? `参考答案：${question.answer}` : '',
                question.explanation ? `解析：${question.explanation}` : '',
            ].filter(Boolean).join('\n\n'),
            durationMinutes: index < 2 ? 12 : 8,
        });
    });

    push({
        type: 'summary',
        title: '本课总结',
        markdown: [
            '回顾本节课的核心方法，整理容易出错的位置。',
            questions.length ? '从课堂题目中选 1-2 题复盘：为什么这样做，边界条件是什么。' : '',
            '记录一个需要课后继续练习的问题。',
        ].filter(Boolean).join('\n\n'),
        durationMinutes: 8,
    });

    return {
        schemaVersion: 'tiku.coursewareSlides.v1',
        coursePackageId: coursePackage.id || coursePackage.coursePackageId || null,
        lessonDbId: coursePackage.lessonDbId || lesson.dbId || lesson.lessonDbId || null,
        lessonId: coursePackage.lessonId || lesson.lessonId || null,
        title,
        knowledgeIds: collectCoursewareKnowledgeIds(tikuContext),
        slides,
    };
}

function normalizeCoursewareSlideType(value, order) {
    const raw = String(value || '').toLowerCase();
    if (order === 1 || ['cover', 'title'].includes(raw)) return 'cover';
    if (['example', 'case', 'code', 'trace', 'model'].includes(raw)) return 'example';
    if (['practice', 'assessment', 'diagnostic', 'homework', 'quiz'].includes(raw)) return 'practice';
    if (['summary', 'checklist', 'pitfalls'].includes(raw)) return 'summary';
    return 'concept';
}

function collectCoursewareKnowledgeIds(tikuContext) {
    const ids = new Set();
    const add = (value) => {
        if (value === undefined || value === null || value === '') return;
        ids.add(String(value));
    };
    if (Array.isArray(tikuContext?.knowledgeIds)) {
        tikuContext.knowledgeIds.forEach(add);
    }
    if (Array.isArray(tikuContext?.lesson?.knowledgeIds)) {
        tikuContext.lesson.knowledgeIds.forEach(add);
    }
    add(tikuContext?.knowledge?.nodeId);
    add(tikuContext?.knowledge?.rootNodeId);
    if (Array.isArray(tikuContext?.knowledge?.descendantNodeIds)) {
        tikuContext.knowledge.descendantNodeIds.forEach(add);
    }
    return [...ids];
}

function convertPilotTikuInputToContext(projectPath) {
    const contextPath = path.join(projectPath, 'tiku-context.json');
    const existing = readJsonFileIfExists(contextPath);
    if (existing) return existing;
    const pilotInput = readJsonFileIfExists(path.join(projectPath, 'pilot-tiku-input.json'));
    if (!pilotInput) return null;
    const lesson = pilotInput.lesson || {};
    const knowledgeNode = lesson.knowledgeNode || {};
    const context = {
        schemaVersion: 'tiku.courseContext.v1',
        source: 'tiku',
        subject: 'cpp',
        coursePackage: {
            ...(pilotInput.coursePackage || {}),
            lessonDbId: lesson.dbId,
            lessonId: lesson.lessonId,
            lessonTitle: lesson.title,
        },
        lesson: {
            dbId: lesson.dbId,
            lessonId: lesson.lessonId,
            title: lesson.title,
            status: lesson.status,
            knowledgeIds: lesson.knowledgeIds || [],
        },
        knowledge: {
            rootNodeId: pilotInput.coursePackage?.rootKnowledgeId,
            nodeId: knowledgeNode.id || lesson.knowledgeIds?.[0],
            nodeName: knowledgeNode.name || lesson.title,
            path: Array.isArray(knowledgeNode.path) ? knowledgeNode.path.join(' / ') : knowledgeNode.path,
            descendantNodeIds: lesson.knowledgeIds || [],
        },
        questionPolicy: {
            source: 'tiku-first-ai-fill',
            preferredKinds: ['class_practice', 'homework', 'quiz'],
            maxCandidates: 12,
            allowAiDraftForGaps: true,
        },
        questions: [],
        materials: [],
        eduAssessment: pilotInput.eduAssessment,
        ojProblems: pilotInput.ojProblems,
        currentAssets: pilotInput.currentAssets,
        teacherConstraints: {
            durationMinutes: 180,
            mode: 'teacher-led',
            outputs: ['courseware-slides.json', 'deck.html', 'teacher-script.md', 'video-script.md', 'courseware-package.json'],
        },
        legacyPilotInput: {
            schemaVersion: pilotInput.schemaVersion,
            createdAt: pilotInput.createdAt,
            intent: pilotInput.intent,
            guardrails: pilotInput.guardrails,
            expectedOutputs: pilotInput.expectedOutputs,
        },
    };
    fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));
    return context;
}

function extractDeckSections(deckHtml) {
    const sections = [];
    const regex = /<section\b[^>]*>([\s\S]*?)<\/section>/gi;
    let match;
    while ((match = regex.exec(deckHtml))) {
        sections.push(match[1]);
    }
    if (sections.length > 0) return sections;
    const body = deckHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
    return body ? [body] : [];
}

function buildCoursewareSlidesFromLegacyAssets(projectName, projectPath, assetFiles, tikuContext, title) {
    const existingAsset = firstExistingCoursewareAsset(assetFiles, ['courseware-slides.json']);
    if (existingAsset) return existingAsset;

    const manifestAsset = firstExistingCoursewareAsset(assetFiles, ['slides-manifest.json']);
    const deckAsset = firstExistingCoursewareAsset(assetFiles, [
        'deck.html',
        'slides.html',
        'courseware.html',
        'teach-courseware.html',
        'index.html',
        'word-form-courseware/index.html',
    ]);
    if (!manifestAsset && !deckAsset) return undefined;

    const manifest = manifestAsset ? readJsonFileIfExists(path.join(projectPath, manifestAsset)) : null;
    const deckHtml = deckAsset ? readCoursewareAssetText(projectPath, deckAsset) : '';
    const sectionHtml = extractDeckSections(deckHtml);
    const manifestSlides = Array.isArray(manifest?.slides) ? manifest.slides : [];
    const slideCount = Math.max(sectionHtml.length, manifestSlides.length, 1);
    const slides = [];
    for (let index = 0; index < slideCount; index += 1) {
        const order = index + 1;
        const manifestSlide = manifestSlides[index] || {};
        const rawHtml = sectionHtml[index] || `<section><h2>${manifestSlide.title || `${title} ${order}`}</h2></section>`;
        const safeHtml = sanitizeCoursewareStudentHtml(rawHtml);
        const text = stripHtmlTags(safeHtml);
        const slideTitle = manifestSlide.title || stripHtmlTags(rawHtml).slice(0, 32) || `第 ${order} 页`;
        slides.push({
            id: manifestSlide.id || `slide-${String(order).padStart(2, '0')}`,
            order,
            type: normalizeCoursewareSlideType(manifestSlide.type || manifestSlide.kind, order),
            title: slideTitle,
            html: safeHtml || `<section><h2>${slideTitle}</h2></section>`,
            markdown: manifestSlide.markdown || `## ${slideTitle}\n\n${text}`,
            notes: manifestSlide.notes || '',
            duration_minutes: Number(manifestSlide.duration_minutes || manifestSlide.durationMinutes || 3),
            student_visible: manifestSlide.student_visible !== false,
        });
    }

    const coursePackage = tikuContext?.coursePackage || {};
    const lesson = tikuContext?.lesson || {};
    const slidesPackage = {
        schemaVersion: 'tiku.coursewareSlides.v1',
        coursePackageId: coursePackage.id || coursePackage.coursePackageId || null,
        lessonDbId: coursePackage.lessonDbId || lesson.dbId || lesson.lessonDbId || null,
        lessonId: coursePackage.lessonId || lesson.lessonId || manifest?.lessonId || projectName,
        title: manifest?.title || coursePackage.lessonTitle || lesson.title || title,
        knowledgeIds: collectCoursewareKnowledgeIds(tikuContext),
        slides,
    };
    const outputName = 'courseware-slides.json';
    fs.writeFileSync(path.join(projectPath, outputName), JSON.stringify(slidesPackage, null, 2));
    if (!assetFiles.includes(outputName)) {
        assetFiles.push(outputName);
    }
    return outputName;
}

function createCoursewareAssetPackage(projectName, projectPath, assetFiles) {
    const tikuContext = convertPilotTikuInputToContext(projectPath) || readJsonFileIfExists(path.join(projectPath, 'tiku-context.json'));
    const existingPackage = readJsonFileIfExists(path.join(projectPath, 'courseware-package.json')) || {};
    const existingHandoff = readJsonFileIfExists(path.join(projectPath, 'generator-handoff.json')) || {};
    const sourceLock = readJsonFileIfExists(path.join(projectPath, 'source-lock.json')) || {};
    const agentRun = readJsonFileIfExists(path.join(projectPath, 'agent-run.json')) || {};
    const brief = readCoursewareAssetText(projectPath, 'brief.md');
    const outline = readCoursewareAssetText(projectPath, 'course-outline.md');
    const teacherScript = readCoursewareAssetText(projectPath, 'teacher-script.md');
    const exercises = readCoursewareAssetText(projectPath, 'exercises.md');
    const homework = readCoursewareAssetText(projectPath, 'homework.md');
    const pitfalls = readCoursewareAssetText(projectPath, 'pitfalls.md');
    const parentFeedback = readCoursewareAssetText(projectPath, 'parent-feedback.md');
    const handoffNotes =
        readCoursewareAssetText(projectPath, 'generator-notes.md') ||
        readCoursewareAssetText(projectPath, 'openmaic-handoff.md');
    const versionedAssetContents = [
        'courseware-slides.json',
        'slides-manifest.json',
        'tiku-context.json',
    ].map((fileName) => {
        const filePath = path.join(projectPath, fileName);
        return fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0);
    });
    const contentHash = crypto
        .createHash('sha256')
        .update([brief, outline, teacherScript, exercises, homework, pitfalls, parentFeedback, handoffNotes].join('\n---tc-asset---\n'))
        .update(Buffer.concat(versionedAssetContents))
        .digest('hex');
    const packageId = existingPackage.packageId || existingHandoff.packageId || `tc-course-${contentHash.slice(0, 16)}`;
    const subject = resolveCoursewareSubjectFromAssets(projectPath);
    const title =
        existingHandoff.topic ||
        existingHandoff.title ||
        existingPackage.title ||
        compactCoursewareTitle(outline || brief || handoffNotes, projectName);
    const now = new Date().toISOString();
    const coursewareSlidesAsset = buildCoursewareSlidesFromLegacyAssets(projectName, projectPath, assetFiles, tikuContext, title);
    const htmlAsset = firstExistingCoursewareAsset(assetFiles, [
        'deck.html',
        'slides.html',
        'courseware.html',
        'teach-courseware.html',
        'index.html',
        'word-form-courseware/index.html',
    ]);
    const deckHtmlAsset = firstExistingCoursewareAsset(assetFiles, [
        'deck.html',
        'slides.html',
        'word-form-courseware/index.html',
    ]) || (htmlAsset && /(^|\/)(deck|slides|index)\.html$/.test(htmlAsset) ? htmlAsset : undefined);
    const pptxAsset = firstExistingCoursewareAsset(assetFiles, [
        'courseware.pptx',
        'deck.pptx',
        'slides.pptx',
    ]);
    const slidesManifestAsset = firstExistingCoursewareAsset(assetFiles, ['slides-manifest.json']);
    const videoScriptAsset = firstExistingCoursewareAsset(assetFiles, ['video-script.md']);

    return {
        schemaVersion: 'tiku.courseAsset.v1',
        packageId,
        coursePackageId: existingPackage.coursePackageId || existingHandoff.coursePackageId || tikuContext?.coursePackage?.id,
        lessonDbId: existingPackage.lessonDbId || existingHandoff.lessonDbId || tikuContext?.coursePackage?.lessonDbId || tikuContext?.lesson?.dbId,
        lessonId: existingPackage.lessonId || existingHandoff.lessonId || projectName,
        title,
        sourceSystem: 'tongcheng-courseware-assistant',
        projectName,
        subject,
        gradeLevel: existingPackage.gradeLevel || existingHandoff.gradeLevel || tikuContext?.gradeLevel || 'CSP-J',
        topic: title,
        outputs: ['html_slides', 'html_preview', 'ppt_backup', 'candidate_package', 'video_script'],
        sourceOfTruth: coursewareSlidesAsset || 'courseware-slides.json',
        coursewareSlides: coursewareSlidesAsset || null,
        derivedAssets: ['deck.html', 'pptx', 'pdf'],
        creativeSource: coursewareSlidesAsset ? 'tongcheng-html-slides' : htmlAsset || pptxAsset ? 'tongcheng-creative-deck' : 'structured-assets',
        standardizationMode: coursewareSlidesAsset ? 'write-courseware-slides-to-tiku' : htmlAsset ? 'derive-slides-from-preview' : 'generate-from-structured-assets',
        status: agentRun.status || existingPackage.status || existingHandoff.status || 'reviewing',
        runId: agentRun.runId || sourceLock.runId || null,
        operationMode: agentRun.operationMode || null,
        source: {
            ...(tikuContext?.source ? { upstream: tikuContext.source } : {}),
            workspaceId: projectName,
            projectName,
            sourceFiles: assetFiles,
            contentHash,
        },
        ...(tikuContext?.knowledge ? {
            knowledgeNodeId: tikuContext.knowledge.nodeId || tikuContext.knowledge.rootNodeId,
            knowledgeNodeName: tikuContext.knowledge.nodeName,
            knowledgePath: tikuContext.knowledge.path,
        } : {}),
        ...(tikuContext?.coursePackage ? {
            coursePackage: tikuContext.coursePackage,
        } : {}),
        ...(Array.isArray(tikuContext?.questions) ? {
            tikuQuestions: tikuContext.questions.map((question) => ({
                question_id: question.question_id,
                knowledge_id: question.knowledge_id,
                kind: question.kind,
                type: question.type,
                difficulty: question.difficulty,
                tags: question.tags,
            })).filter((question) => question.question_id),
        } : {}),
        visibility: {
            teacherOnly: ['teacher-script.md', 'pitfalls.md'],
            studentVisible: ['brief.md', 'course-outline.md'],
            parentVisible: parentFeedback ? ['parent-feedback.md'] : [],
        },
        assets: {
            ...(coursewareSlidesAsset ? { coursewareSlides: coursewareSlidesAsset } : {}),
            ...(htmlAsset ? { html: htmlAsset } : {}),
            ...(deckHtmlAsset ? { deckHtml: deckHtmlAsset } : {}),
            ...(pptxAsset ? { pptx: pptxAsset } : {}),
            ...(slidesManifestAsset ? { slidesManifest: slidesManifestAsset } : {}),
            ...(brief ? { brief: 'brief.md' } : {}),
            ...(outline ? { courseOutline: 'course-outline.md' } : {}),
            ...(teacherScript ? { teacherScript: 'teacher-script.md' } : {}),
            ...(exercises ? { exercises: 'exercises.md' } : {}),
            ...(homework ? { homework: 'homework.md' } : {}),
            ...(pitfalls ? { pitfalls: 'pitfalls.md' } : {}),
            ...(videoScriptAsset ? { videoScript: videoScriptAsset } : {}),
            ...(fs.existsSync(path.join(projectPath, 'source-lock.json')) ? { sourceLock: 'source-lock.json' } : {}),
            ...(fs.existsSync(path.join(projectPath, 'agent-run.json')) ? { agentRun: 'agent-run.json' } : {}),
            ...(fs.existsSync(path.join(projectPath, 'asset-request.json')) ? { assetRequest: 'asset-request.json' } : {}),
        },
        entryPolicy: 'students_enter_from_learn_class',
        teacherEntry: existingPackage.teacherEntry || 'https://teach.tongchengweilai.com/admin-classes.html',
        studentEntry: existingPackage.studentEntry || 'https://learn.tongchengweilai.com',
        tikuEntry: existingPackage.tikuEntry || 'https://tiku.tongchengweilai.com/teacher',
        notes: [
            '由童澄教研创作台沉淀的课程资产包。',
            coursewareSlidesAsset
                ? '已包含可写入 Tiku metadata.courseware_slides 的 HTML slides 主源；deck/PPT/PDF 仅作预览或导出。'
                : '当前未检测到 HTML slides 主源，下游可按结构化资产生成预览。',
            '练习内容为候选，需要在 Tiku 中审核后再进入正式作业或试卷。',
        ],
        createdAt: now,
        updatedAt: now,
    };
}

function writeCoursewareHandoffFiles(projectPath, assetPackage) {
    const json = JSON.stringify(assetPackage, null, 2);
    fs.writeFileSync(path.join(projectPath, 'generator-handoff.json'), json);
    fs.writeFileSync(path.join(projectPath, 'courseware-package.json'), json);
}

function safeSlug(value, fallback = 'course-program') {
    const slug = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return slug || fallback;
}

function readJsonFileIfExists(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function coursewareProgramManifestPath(projectPath, programId = null, options = {}) {
    const normalizedProgramId = safeSlug(programId || options.programId || '', '');
    if (!normalizedProgramId || normalizedProgramId === 'root' || normalizedProgramId === 'default') {
        return path.join(projectPath, 'course-program.json');
    }
    return path.join(projectPath, 'course-programs', normalizedProgramId, 'course-program.json');
}

function coursewareProgramRoot(projectPath, manifestPath) {
    return path.dirname(manifestPath);
}

function listCoursewarePrograms(projectPath, activeProgramId = null) {
    const programs = [];
    const seen = new Set();
    function addProgram(manifestPath, location) {
        const manifest = readJsonFileIfExists(manifestPath);
        if (!manifest || manifest.schemaVersion !== 'tiku.courseProgram.v1') return;
        const programId = String(manifest.programId || safeSlug(manifest.title, location === 'root' ? 'root' : path.basename(path.dirname(manifestPath))));
        if (seen.has(programId)) return;
        seen.add(programId);
        programs.push({
            programId,
            title: manifest.title || programId,
            subject: manifest.subject || 'cpp',
            level: manifest.level,
            lessonCount: Number(manifest.lessonCount || manifest.lessons?.length || 0),
            location,
            active: activeProgramId ? activeProgramId === programId : programs.length === 0,
            manifestPath,
            relativePath: path.relative(projectPath, manifestPath).split(path.sep).join('/'),
        });
    }

    addProgram(path.join(projectPath, 'course-program.json'), 'root');
    const programsDir = path.join(projectPath, 'course-programs');
    try {
        for (const entry of fs.readdirSync(programsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            addProgram(path.join(programsDir, entry.name, 'course-program.json'), entry.name);
        }
    } catch {
        // Multiple course packages are optional.
    }
    return programs.map((program) => ({
        ...program,
        active: activeProgramId ? program.programId === activeProgramId : program === programs[0],
    }));
}

function scanCoursewareSourceMaterials(projectPath) {
    const ignoredDirs = new Set(['.git', '.pilotdeck', '.tmp', '.venv', '.venv-pptx', 'node_modules', 'dist', 'build', '.next']);
    const interestingExt = new Set(['.md', '.docx', '.pptx', '.html', '.json']);
    const materials = [];
    const lessonSources = new Map();

    function classify(relativePath, fileName) {
        if (/parent-feedback|家长|反馈/i.test(relativePath)) return 'feedback';
        if (/homework|作业/i.test(relativePath)) return 'homework';
        if (/oj|edu|exercises|题|练习/i.test(relativePath)) return 'question-bank';
        if (/ppt|slide|deck|演示/i.test(relativePath)) return 'presentation';
        if (/learn|整合/i.test(relativePath)) return 'learn-integration';
        if (/course|课程|总表|计划|outline|大纲/i.test(relativePath)) return 'planning';
        return 'material';
    }

    function scan(dir, depth = 0) {
        if (depth > 5 || materials.length >= 240) return;
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || ignoredDirs.has(entry.name)) continue;
            const absolute = path.join(dir, entry.name);
            const relativePath = path.relative(projectPath, absolute).split(path.sep).join('/');
            if (entry.isDirectory()) {
                const lessonMatch = entry.name.match(/^(?:J|j|lesson-)?0?(\d{1,2})\b/);
                if (lessonMatch && listCoursewareAssetFiles(absolute).length > 0) {
                    const order = Number(lessonMatch[1]);
                    if (order > 0 && !lessonSources.has(order)) {
                        lessonSources.set(order, absolute);
                    }
                }
                scan(absolute, depth + 1);
                continue;
            }
            const ext = path.extname(entry.name).toLowerCase();
            if (!interestingExt.has(ext)) continue;
            if (relativePath === 'course-program.json' || relativePath === 'program.md') continue;
            materials.push({
                name: entry.name,
                relativePath,
                kind: classify(relativePath, entry.name),
            });
        }
    }

    scan(projectPath);
    return {
        materials,
        lessonSources: [...lessonSources.entries()].map(([order, absolutePath]) => ({
            order,
            relativePath: path.relative(projectPath, absolutePath).split(path.sep).join('/'),
        })).sort((a, b) => a.order - b.order),
    };
}

function findLinkedLessonSourcePath(projectPath, lesson) {
    if (lesson.sourcePath) {
        const absolute = path.resolve(projectPath, lesson.sourcePath);
        if (absolute.startsWith(path.resolve(projectPath)) && fs.existsSync(absolute) && listCoursewareAssetFiles(absolute).length > 0) return absolute;
    }
    const order = Number(lesson.order || 0);
    if (!order) return null;
    const candidates = [
        path.join(projectPath, lesson.lessonId),
        path.join(projectPath, `lesson-${String(order).padStart(2, '0')}`),
        path.join(projectPath, `J${String(order).padStart(2, '0')}`),
        path.join(projectPath, 'csp-summer-plan', 'CSP-J-course-packages', `J${String(order).padStart(2, '0')}`),
        path.join(projectPath, 'course-packages', `J${String(order).padStart(2, '0')}`),
        path.join(projectPath, 'packages', `lesson-${String(order).padStart(2, '0')}`),
    ];
    return candidates.find((candidate) =>
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isDirectory() &&
        listCoursewareAssetFiles(candidate).length > 0
    ) || null;
}

function mergeAssetFiles(primaryFiles, sourceFiles, sourceRelativePrefix) {
    const merged = [...primaryFiles];
    for (const fileName of sourceFiles) {
        const relative = sourceRelativePrefix ? `${sourceRelativePrefix}/${fileName}` : fileName;
        if (!merged.includes(relative)) merged.push(relative);
    }
    return merged;
}

function hasAsset(assetFiles, exactNames, patterns = []) {
    return assetFiles.some((fileName) =>
        exactNames.includes(fileName.split('/').pop()) ||
        exactNames.includes(fileName) ||
        patterns.some((pattern) => pattern.test(fileName)),
    );
}

function ensureCoursewareProgram(projectName, projectPath, options = {}) {
    const manifestPath = coursewareProgramManifestPath(projectPath, options.programId, options);
    const existing = readJsonFileIfExists(manifestPath);
    const lessonCount = Math.max(1, Math.min(60, Number(options.lessonCount || existing?.lessonCount || 12) || 12));
    const title = String(options.title || existing?.title || compactCoursewareTitle(readCoursewareAssetText(projectPath, 'program.md'), projectName));
    const subject = String(options.subject || existing?.subject || resolveCoursewareSubjectFromAssets(projectPath));
    const level = String(options.level || existing?.level || '').trim();
    const now = new Date().toISOString();
    const programRoot = coursewareProgramRoot(projectPath, manifestPath);
    const lessonsRoot = path.join(programRoot, 'lessons');
    fs.mkdirSync(programRoot, { recursive: true });
    fs.mkdirSync(lessonsRoot, { recursive: true });

    const existingLessons = Array.isArray(existing?.lessons) ? existing.lessons : [];
    const lessons = Array.from({ length: lessonCount }, (_, index) => {
        const order = index + 1;
        const lessonId = `lesson-${String(order).padStart(2, '0')}`;
        const previous = existingLessons.find((lesson) => lesson?.lessonId === lessonId || Number(lesson?.order) === order) || {};
        const lessonTitle = String(previous.title || `第 ${order} 次课`);
        const relativePath = path.relative(projectPath, path.join(lessonsRoot, lessonId)).split(path.sep).join('/');
        fs.mkdirSync(path.join(projectPath, relativePath), { recursive: true });
        return {
            lessonId,
            order,
            title: lessonTitle,
            workspacePath: relativePath,
            packageFile: `${relativePath}/courseware-package.json`,
            schemaVersion: 'tiku.courseAsset.v1',
            status: previous.status || 'empty',
        };
    });
    const programId = existing?.programId || options.programId || `tc-program-${safeSlug(projectName)}`;

    const program = {
        schemaVersion: 'tiku.courseProgram.v1',
        programId,
        sourceSystem: 'tongcheng-courseware-assistant',
        title,
        subject,
        ...(level ? { level } : {}),
        lessonCount,
        projectName,
        source: {
            workspaceId: projectName,
            sourceFiles: ['program.md', 'course-program.json'],
        },
        lessons,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(program, null, 2));
    const programDocPath = path.join(programRoot, 'program.md');
    if (!fs.existsSync(programDocPath)) {
        fs.writeFileSync(programDocPath, `# ${title}\n\n- 学科：${subject}\n- 课次数：${lessonCount}\n- 状态：课程包草稿\n`);
    }
    return program;
}

function summarizeCoursewareLesson(projectPath, lesson) {
    const relativePath = String(lesson.workspacePath || `lessons/${lesson.lessonId}`);
    const lessonPath = path.join(projectPath, relativePath);
    fs.mkdirSync(lessonPath, { recursive: true });
    const assetFiles = listCoursewareAssetFiles(lessonPath);
    const linkedSourcePath = findLinkedLessonSourcePath(projectPath, lesson);
    const linkedSourceRelativePath = linkedSourcePath
        ? path.relative(projectPath, linkedSourcePath).split(path.sep).join('/')
        : null;
    const sourceAssetFiles = linkedSourcePath ? listCoursewareAssetFiles(linkedSourcePath) : [];
    const allAssetFiles = mergeAssetFiles(assetFiles, sourceAssetFiles, linkedSourceRelativePath);
    let packageData = readJsonFileIfExists(path.join(lessonPath, 'courseware-package.json'));
    if (!packageData && linkedSourcePath) {
        packageData = readJsonFileIfExists(path.join(linkedSourcePath, 'courseware-package.json'));
    }
    if (!packageData && assetFiles.length > 0) {
        packageData = createCoursewareAssetPackage(lesson.lessonId, lessonPath, assetFiles);
    }
    const assets = {
        brief: hasAsset(allAssetFiles, ['brief.md']),
        outline: hasAsset(allAssetFiles, ['course-outline.md', 'ppt-outline.md', 'complete-course-package.md'], [/课程包\.md$/, /课程总表\.md$/]),
        teacherScript: hasAsset(allAssetFiles, ['teacher-script.md']),
        exercises: hasAsset(allAssetFiles, ['exercises.md', 'edu-exercises.md', 'oj-exercises.md']),
        pitfalls: hasAsset(allAssetFiles, ['pitfalls.md']),
        coursewareSlides: hasAsset(allAssetFiles, ['courseware-slides.json']),
        deck: hasAsset(allAssetFiles, ['deck.html', 'slides.html', 'courseware.html', 'teach-courseware.html', 'index.html']),
        videoScript: hasAsset(allAssetFiles, ['video-script.md']),
        package: hasAsset(allAssetFiles, ['courseware-package.json', 'generator-handoff.json']),
        homework: hasAsset(allAssetFiles, ['homework.md']),
        ojExercises: hasAsset(allAssetFiles, ['oj-exercises.md']),
        eduExercises: hasAsset(allAssetFiles, ['edu-exercises.md']),
        parentFeedback: hasAsset(allAssetFiles, ['parent-feedback.md']),
        courseFeedback: hasAsset(allAssetFiles, ['course-feedback.md', 'teacher-feedback.md']),
        learnIntegration: hasAsset(allAssetFiles, ['learn-integration.md'], [/learn.*整合.*\.md$/, /整合方案\.md$/]),
        pptOutline: hasAsset(allAssetFiles, ['ppt-outline.md', 'slides-manifest.json']),
        pptx: hasAsset(allAssetFiles, ['courseware.pptx', 'deck.pptx', 'slides.pptx'], [/\.pptx$/]),
    };
    const coreAssetKeys = ['brief', 'outline', 'teacherScript', 'exercises', 'coursewareSlides', 'package'];
    const completion = Math.round((coreAssetKeys.filter((key) => assets[key]).length / coreAssetKeys.length) * 100);
    const status = packageData?.status || (completion >= 75 ? 'ready' : completion > 0 ? 'draft' : 'empty');
    const agentRunData = readCoursewareAgentRun(lessonPath);
    const agentRun = agentRunData ? summarizeCoursewareAgentRun(agentRunData, lessonPath) : null;
    return {
        lessonId: lesson.lessonId,
        order: Number(lesson.order || 0),
        title: packageData?.topic || lesson.title || lesson.lessonId,
        workspacePath: lessonPath,
        relativePath,
        status,
        assetFiles: allAssetFiles,
        localAssetFiles: assetFiles,
        sourceAssetFiles,
        linkedSourcePath,
        linkedSourceRelativePath,
        assets,
        completion,
        packageId: packageData?.packageId,
        topic: packageData?.topic,
        updatedAt: packageData?.updatedAt,
        agentRun,
    };
}

function getCoursewareProgramStatus(projectName, projectPath, options = {}) {
    const activeProgramId = options.programId || null;
    const program = ensureCoursewareProgram(projectName, projectPath, options);
    const lessons = program.lessons.map((lesson) => summarizeCoursewareLesson(projectPath, lesson));
    const missing = lessons
        .filter((lesson) => lesson.completion < 75)
        .map((lesson) => `${lesson.lessonId}:${lesson.title}`);
    const readyCount = lessons.filter((lesson) => lesson.completion >= 75).length;
    const programs = listCoursewarePrograms(projectPath, program.programId || activeProgramId);
    const sourceScan = scanCoursewareSourceMaterials(projectPath);
    return {
        schemaVersion: 'tiku.courseProgram.v1',
        programId: program.programId,
        title: program.title,
        subject: program.subject,
        level: program.level,
        lessonCount: program.lessonCount,
        projectName,
        projectPath,
        status: readyCount === 0 ? 'draft' : readyCount === lessons.length ? 'ready' : 'in_progress',
        lessons,
        missing,
        programs,
        sourceMaterials: sourceScan.materials,
        lessonSources: sourceScan.lessonSources,
        updatedAt: new Date().toISOString(),
    };
}

function getCoursewareProgramProgress(projectName, projectPath, options = {}) {
    const status = getCoursewareProgramStatus(projectName, projectPath, options);
    const expectedCore = ['brief', 'outline', 'teacherScript', 'exercises', 'deck', 'package'];
    const expectedTotal = Math.max(1, status.lessons.length * expectedCore.length);
    const readyTotal = status.lessons.reduce((sum, lesson) => {
        return sum + expectedCore.filter((key) => lesson.assets?.[key]).length;
    }, 0);
    const percent = Math.round((readyTotal / expectedTotal) * 100);
    const activeLesson = status.lessons.find((lesson) => lesson.agentRun && !['ready', 'cancelled'].includes(lesson.agentRun.status)) ||
        status.lessons.find((lesson) => lesson.completion > 0 && lesson.completion < 100) ||
        status.lessons.find((lesson) => lesson.completion === 0) ||
        status.lessons[status.lessons.length - 1] ||
        null;
    const missingCore = activeLesson
        ? expectedCore.filter((key) => !activeLesson.assets?.[key])
        : [];
    const stage = percent >= 100
        ? '已完成基础资产'
        : activeLesson
            ? `第 ${activeLesson.order} 次课待补齐：${missingCore.join(' / ') || '标准包验收'}`
            : '等待初始化课程包';

    return {
        schemaVersion: 'tiku.coursewareProgress.v1',
        projectName,
        programId: status.programId,
        title: status.title,
        percent,
        readyTotal,
        expectedTotal,
        status: percent >= 100 ? 'ready' : readyTotal > 0 ? 'in_progress' : 'draft',
        stage,
        activeLesson: activeLesson ? {
            lessonId: activeLesson.lessonId,
            order: activeLesson.order,
            title: activeLesson.title,
            completion: activeLesson.completion,
            relativePath: activeLesson.relativePath,
            missing: missingCore,
            agentRun: activeLesson.agentRun || null,
        } : null,
        updatedAt: status.updatedAt,
    };
}

async function refreshCoursewareProgramPackages(projectName, projectPath, options = {}) {
    const program = ensureCoursewareProgram(projectName, projectPath, options);
    const refreshed = [];
    for (const lesson of program.lessons) {
        const lessonPath = path.join(projectPath, lesson.workspacePath);
        let assetPath = lessonPath;
        let assetFiles = listCoursewareAssetFiles(assetPath);
        const linkedSourcePath = findLinkedLessonSourcePath(projectPath, lesson);
        if (assetFiles.length === 0 && linkedSourcePath) {
            assetPath = linkedSourcePath;
            assetFiles = listCoursewareAssetFiles(assetPath);
        }
        if (assetFiles.length === 0) {
            refreshed.push({ lessonId: lesson.lessonId, skipped: true, reason: 'empty' });
            continue;
        }
        const assetPackage = createCoursewareAssetPackage(`${projectName}-${lesson.lessonId}`, assetPath, assetFiles);
        writeCoursewareHandoffFiles(assetPath, assetPackage);
        const validation = await validateTongchengCoursewareWorkspace(assetPath, { publishTarget: 'learn' });
        refreshed.push({
            lessonId: lesson.lessonId,
            packageId: assetPackage.packageId,
            validation: {
                ok: validation.ok,
                issueCount: validation.issues.length,
                warningCount: validation.warnings.length,
            },
            assetFiles,
            relativePath: path.relative(projectPath, assetPath).split(path.sep).join('/'),
        });
    }
    const status = getCoursewareProgramStatus(projectName, projectPath, options);
    fs.writeFileSync(path.join(projectPath, 'generator-handoff.json'), JSON.stringify(status, null, 2));
    return { status, refreshed };
}

function assertCoursewareWorkspacePath(projectPath) {
    const root = path.resolve(
        process.env.TONGCHENG_ASSET_WORKSPACES_ROOT ||
        path.join(__dirname, '..', '..', 'workspaces'),
    );
    const resolved = path.resolve(projectPath);
    const isAssetWorkspace = resolved === root || resolved.startsWith(`${root}${path.sep}`);
    const hasCoursewareMarker = [
        'course-program.json',
        'tiku-context.json',
        'courseware-slides.json',
        'courseware-package.json',
        'generator-handoff.json',
        'brief.md',
        'course-outline.md',
        'teacher-script.md',
    ].some((fileName) => fs.existsSync(path.join(resolved, fileName)));
    if (!isAssetWorkspace && !hasCoursewareMarker) {
        const error = new Error('课程资产工作区不在允许范围内');
        error.statusCode = 403;
        throw error;
    }
    return resolved;
}

const requireTongchengServiceToken = createTongchengBridgeAuth();

function resolveCoursewareLessonWorkspaceName(tikuContext) {
    const coursePackage = tikuContext?.coursePackage || {};
    const lesson = tikuContext?.lesson || {};
    const lessonId = coursePackage.lessonId || lesson.lessonId || lesson.dbId || 'lesson';
    const title = coursePackage.title || coursePackage.lessonTitle || lesson.title || 'courseware';
    return safeSlug(`${coursePackage.id || coursePackage.coursePackageId || 'tiku'}-${lessonId}-${title}`, 'tiku-courseware');
}

function writeTikuGenerationRequest(projectPath, tikuContext) {
    const coursePackage = tikuContext?.coursePackage || {};
    const request = tikuContext?.generationRequest || {};
    const knowledgeNames = Array.isArray(tikuContext?.knowledge?.selectedNodes)
        ? tikuContext.knowledge.selectedNodes.map((node) => node.name).filter(Boolean).slice(0, 12)
        : [];
    const questionCount = Array.isArray(tikuContext?.questions) ? tikuContext.questions.length : 0;
    const aiDraftCount = Array.isArray(tikuContext?.aiDraftQuestions) ? tikuContext.aiDraftQuestions.length : 0;
    const title = request.lessonTitle || coursePackage.lessonTitle || coursePackage.title || '课堂课件';
    const lines = [
        `# ${title}`,
        '',
        '## 课程目标',
        request.objectives || '按当前课次目标生成可上课课件。',
        '',
        '## 知识点范围',
        request.knowledgeScope || (knowledgeNames.length ? knowledgeNames.join('、') : '按 Tiku 当前课次知识点范围。'),
        '',
        '## 题目范围',
        request.questionScope || '优先使用 Tiku 已审核题目；AI 题只作为草稿候选。',
        '',
        '## 课堂风格',
        request.classroomStyle || '讲一点、练一点、复盘一点。',
        '',
        '## 题量控制',
        request.questionLimit || '课堂精讲 6-8 道，随堂练习 12-16 道。',
        '',
        '## 生成选项',
        `- 互动 HTML 知识点页：${request.generateInteractiveHtml === false ? '否' : '是'}`,
        `- AI 同类题入口：${request.includeSimilarQuestionPrompt === false ? '否' : '是'}`,
        `- 生成模式：${request.rebuildMode === 'rebuild' ? '重建课件' : '生成课件'}`,
        '',
        '## 当前题源摘要',
        `- 已传入 Tiku 正式题：${questionCount} 道`,
        `- AI 草稿候选：${aiDraftCount} 道`,
        `- 选中知识点：${knowledgeNames.length ? knowledgeNames.join('、') : '未指定'}`,
        '',
        '## 发布约束',
        '- 没有真实 Tiku question_id 的题目只能标记为 ai-draft 或 manual，不能伪装成正式题。',
        '- 学生可见 HTML 不得出现生产系统、审核、内部路径或技术元数据。',
    ];
    fs.writeFileSync(path.join(projectPath, 'teacher-request.md'), lines.join('\n'), 'utf8');
}

function normalizeTikuGeneratedSlide(slide, index) {
    const order = Number(slide?.order || index + 1);
    const rawDuration = slide?.duration_minutes ?? slide?.durationMinutes ?? (
        slide?.durationSec == null ? null : Math.max(1, Math.round(Number(slide.durationSec) / 60))
    );
    return {
        ...slide,
        id: String(slide?.id || `slide-${String(order).padStart(2, '0')}`),
        order,
        type: normalizeCoursewareSlideType(slide?.type, order),
        title: cleanCoursewareStudentText(slide?.title || `第 ${order} 页`),
        html: sanitizeCoursewareStudentHtml(String(slide?.html || '')),
        markdown: cleanCoursewareStudentText(slide?.markdown || ''),
        notes: String(slide?.notes || '').trim(),
        duration_minutes: rawDuration == null ? null : Number(rawDuration),
        student_visible: slide?.student_visible !== false,
    };
}

function buildCoursewareDeckHtmlFromSlides(slidesPackage, title = '课堂课件') {
    const slides = Array.isArray(slidesPackage?.slides) ? slidesPackage.slides : [];
    const body = slides.map((slide, index) => {
        const normalized = normalizeTikuGeneratedSlide(slide, index);
        const html = normalized.html || makeCoursewareSlideHtml({
            title: normalized.title,
            kicker: normalized.type === 'cover' ? '课程导入' : '课堂课件',
            markdown: normalized.markdown || normalized.title,
            type: normalized.type,
        });
        return `<section class="tc-deck-page" data-slide-id="${escapeHtml(normalized.id)}">${html}</section>`;
    }).join('\n');
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7fb; color: #172033; }
    body { margin: 0; background: #f6f7fb; }
    .tc-deck { display: grid; gap: 24px; padding: 24px; }
    .tc-deck-page { width: min(1180px, calc(100vw - 48px)); min-height: 660px; margin: 0 auto; background: white; border: 1px solid #e1e5ee; border-radius: 8px; box-shadow: 0 16px 40px rgba(18, 25, 38, .08); overflow: hidden; }
    .tc-deck-page > section, .tc-deck-page .slide, .tc-deck-page .tc-slide { min-height: 660px; box-sizing: border-box; padding: 56px; }
    h1, h2, h3 { letter-spacing: 0; }
    h1 { font-size: 48px; line-height: 1.12; margin: 0 0 20px; }
    h2 { font-size: 36px; line-height: 1.18; margin: 0 0 24px; }
    h3 { font-size: 22px; margin: 0 0 12px; }
    p, li, td, th { font-size: 20px; line-height: 1.6; }
    pre, code { font-family: "SFMono-Regular", Consolas, monospace; }
    pre { background: #111827; color: #f8fafc; padding: 18px; border-radius: 8px; overflow: auto; }
    .grid, .row { display: grid; gap: 18px; }
    .grid.two, .row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .card { border: 1px solid #d9dee9; border-radius: 8px; padding: 18px; background: #fbfcff; }
    .tip { background: #fff8df; border-left: 5px solid #f3b83f; padding: 14px 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #d9dee9; padding: 12px; text-align: left; vertical-align: top; }
    @media (max-width: 800px) {
      .tc-deck { padding: 12px; }
      .tc-deck-page { width: calc(100vw - 24px); min-height: auto; }
      .tc-deck-page > section, .tc-deck-page .slide, .tc-deck-page .tc-slide { min-height: auto; padding: 28px; }
      .grid.two, .row { grid-template-columns: 1fr; }
      h1 { font-size: 34px; } h2 { font-size: 28px; } p, li, td, th { font-size: 17px; }
    }
    @media print {
      @page { size: 13.333in 7.5in; margin: 0; }
      body { background: white; }
      .tc-deck { display: block; padding: 0; }
      .tc-deck-page { width: 13.333in; min-height: 7.5in; height: 7.5in; margin: 0; border: 0; border-radius: 0; box-shadow: none; break-after: page; page-break-after: always; }
      .tc-deck-page:last-child { break-after: auto; page-break-after: auto; }
    }
  </style>
</head>
<body>
  <main class="tc-deck">
${body}
  </main>
</body>
</html>`;
}

function writeTikuCoursewareDerivedFiles(projectPath, slidesPackage, tikuContext = {}, options = {}) {
    const coursePackage = tikuContext?.coursePackage || {};
    const lesson = tikuContext?.lesson || {};
    const title = slidesPackage?.title || coursePackage.lessonTitle || lesson.title || coursePackage.title || '课堂课件';
    const slides = (Array.isArray(slidesPackage?.slides) ? slidesPackage.slides : []).map(normalizeTikuGeneratedSlide);
    const normalizedPackage = {
        ...(slidesPackage || {}),
        schemaVersion: slidesPackage?.schemaVersion || 'tiku.coursewareSlides.v1',
        coursePackageId: slidesPackage?.coursePackageId || coursePackage.id || coursePackage.coursePackageId || null,
        lessonDbId: slidesPackage?.lessonDbId || coursePackage.lessonDbId || lesson.dbId || null,
        lessonId: slidesPackage?.lessonId || coursePackage.lessonId || lesson.lessonId || null,
        title,
        slides,
    };

    if (options.persistSource !== false) {
        fs.writeFileSync(path.join(projectPath, 'courseware-slides.json'), JSON.stringify(normalizedPackage, null, 2));
    }
    fs.writeFileSync(path.join(projectPath, 'deck.html'), buildCoursewareDeckHtmlFromSlides(normalizedPackage, title));
    fs.writeFileSync(path.join(projectPath, 'slides-manifest.json'), JSON.stringify({
        schemaVersion: 'tiku.slidesManifest.v1',
        lessonId: normalizedPackage.lessonId,
        coursePackageId: normalizedPackage.coursePackageId,
        coursewareSlidesFile: 'courseware-slides.json',
        deckFile: 'deck.html',
        slideCount: slides.length,
        slides: slides.map((slide, index) => ({
            index: index + 1,
            id: slide.id,
            type: slide.type,
            title: slide.title,
            duration_minutes: slide.duration_minutes,
        })),
        updatedAt: new Date().toISOString(),
    }, null, 2));
    return normalizedPackage;
}

let tikuCoursewareOrchestrator = null;

function getTikuCoursewareOrchestrator() {
    if (!tikuCoursewareOrchestrator) {
        tikuCoursewareOrchestrator = createCoursewareAgentOrchestrator({
            runner: createGatewayCoursewareAgentRunner(),
            validateWorkspace: validateTongchengCoursewareWorkspace,
            deriveAssets: async ({ projectPath }) => {
                const slidesPackage = readJsonFileIfExists(path.join(projectPath, 'courseware-slides.json'));
                const tikuContext = readJsonFileIfExists(path.join(projectPath, 'tiku-context.json')) || {};
                if (!slidesPackage) throw new Error('courseware-slides.json is required before deriving assets');
                return writeTikuCoursewareDerivedFiles(projectPath, slidesPackage, tikuContext, { persistSource: false });
            },
            exportPptx: exportPilotDeckPptx,
            exportPdf: exportPilotDeckPdf,
        });
    }
    return tikuCoursewareOrchestrator;
}

function resolveCoursewareGenerationMode(value) {
    const mode = String(value || 'automatic-draft').trim().toLowerCase();
    if (!['automatic-draft', 'high-quality'].includes(mode)) {
        throw Object.assign(new Error(`不支持的课件生成模式：${mode}`), { statusCode: 400 });
    }
    return mode;
}

function writeRequestedApprovedStyle(projectPath, { runId, lessonId, teacherApprovedStyleId, designTokens, teacherNotes }) {
    if (!teacherApprovedStyleId) return null;
    const approved = {
        schemaVersion: 'tongcheng.coursewareApprovedStyle.v1',
        runId,
        lessonId: lessonId || null,
        teacherApprovedStyleId: String(teacherApprovedStyleId),
        approvedAt: new Date().toISOString(),
        designTokens: designTokens && typeof designTokens === 'object' ? designTokens : {},
        teacherNotes: String(teacherNotes || ''),
        source: 'teacher-request',
    };
    fs.writeFileSync(path.join(projectPath, 'approved-style.json'), `${JSON.stringify(approved, null, 2)}\n`, 'utf8');
    return approved;
}

function coursewareApiPayload(projectPath, workspaceName, extra = {}) {
    const run = readCoursewareAgentRun(projectPath);
    const summary = run ? summarizeCoursewareAgentRun(run, projectPath) : {};
    const slidesPackage = readJsonFileIfExists(path.join(projectPath, 'courseware-slides.json'));
    const packageData = readJsonFileIfExists(path.join(projectPath, 'courseware-package.json'));
    const deliveryAssets = readCoursewareDeliveryAssets(projectPath);
    return {
        success: !['blocked', 'failed'].includes(summary.status),
        ...summary,
        workspaceName,
        workspacePath: projectPath,
        projectPath,
        studioUrl: `/p/${encodeURIComponent(workspaceName)}`,
        coursewareSlides: slidesPackage || null,
        package: packageData || null,
        ...deliveryAssets,
        assetFiles: listCoursewareAssetFiles(projectPath),
        ...extra,
    };
}

function buildTikuCoursewareStatus(projectPath, { workspaceName, sessionKey } = {}) {
    const slidesPath = path.join(projectPath, 'courseware-slides.json');
    const slidesPackage = readJsonFileIfExists(slidesPath);
    const slides = Array.isArray(slidesPackage?.slides) ? slidesPackage.slides : [];
    const htmlMissingCount = slides.filter((slide) => !String(slide?.html || '').trim()).length;
    const active = sessionKey ? isSessionActiveViaGateway(sessionKey) : false;

    if (slides.length && htmlMissingCount === 0) {
        const tikuContext = readJsonFileIfExists(path.join(projectPath, 'tiku-context.json')) || {};
        writeTikuCoursewareDerivedFiles(projectPath, slidesPackage, tikuContext);
        const assetFiles = listCoursewareAssetFiles(projectPath);
        const assetPackage = createCoursewareAssetPackage(workspaceName || path.basename(projectPath), projectPath, assetFiles);
        writeCoursewareHandoffFiles(projectPath, assetPackage);
        return {
            success: true,
            status: 'ready',
            progress: 100,
            stage: '课堂课件已生成',
            workspaceName: workspaceName || path.basename(projectPath),
            projectPath,
            sessionKey: sessionKey || '',
            studioUrl: `/p/${encodeURIComponent(workspaceName || path.basename(projectPath))}`,
            coursewareSlides: slidesPackage,
            package: assetPackage,
            assetFiles: listCoursewareAssetFiles(projectPath),
        };
    }

    const report = readJsonFileIfExists(path.join(projectPath, 'courseware-agent-report.json'));
    if (!active && report?.status === 'blocked') {
        return {
            success: true,
            status: 'blocked',
            progress: 0,
            stage: report.blockers?.[0] || report.publish?.reasons?.[0] || '教研创作被阻断',
            workspaceName: workspaceName || path.basename(projectPath),
            projectPath,
            sessionKey: sessionKey || '',
            studioUrl: `/p/${encodeURIComponent(workspaceName || path.basename(projectPath))}`,
            html_missing_count: htmlMissingCount,
            slide_count: slides.length,
            report,
        };
    }

    return {
        success: true,
        status: active ? 'running' : 'pending',
        progress: active ? 65 : 45,
        stage: active ? '教研创作仍在进行' : '等待教研创作结果',
        workspaceName: workspaceName || path.basename(projectPath),
        projectPath,
        sessionKey: sessionKey || '',
        studioUrl: `/p/${encodeURIComponent(workspaceName || path.basename(projectPath))}`,
        html_missing_count: htmlMissingCount,
        slide_count: slides.length,
    };
}

registerCoursewareHttpRoutes(app, {
    auth: requireTongchengServiceToken,
    workspaceRoot: process.env.TONGCHENG_ASSET_WORKSPACES_ROOT || path.join(__dirname, '..', '..', 'workspaces'),
    safeSlug,
    resolveWorkspaceName: resolveCoursewareLessonWorkspaceName,
    resolveGenerationMode: resolveCoursewareGenerationMode,
    listAssetFiles: listCoursewareAssetFiles,
    createAssetPackage: createCoursewareAssetPackage,
    validateWorkspace: validateTongchengCoursewareWorkspace,
    writeGenerationRequest: writeTikuGenerationRequest,
    writeApprovedStyle: writeRequestedApprovedStyle,
    getOrchestrator: getTikuCoursewareOrchestrator,
    apiPayload: coursewareApiPayload,
    buildFallbackSlides: buildCoursewareSlidesFromTikuContext,
    writeDerivedFiles: writeTikuCoursewareDerivedFiles,
    buildLegacyStatus: buildTikuCoursewareStatus,
});

app.post('/api/internal/legacy/tongcheng/tiku/courseware-slides', requireTongchengServiceToken, async (req, res) => {
    try {
        const tikuContext = req.body?.tikuContext || req.body?.context || req.body?.payload;
        if (!tikuContext || tikuContext.schemaVersion !== 'tiku.courseContext.v1') {
            return res.status(400).json({ error: '需要提供 tiku.courseContext.v1 上下文' });
        }
        const workspaceRoot = path.resolve(
            process.env.TONGCHENG_ASSET_WORKSPACES_ROOT ||
            path.join(__dirname, '..', '..', 'workspaces'),
        );
        const workspaceName = safeSlug(req.body?.workspaceName || resolveCoursewareLessonWorkspaceName(tikuContext), 'tiku-courseware');
        const projectPath = path.join(workspaceRoot, workspaceName);
        fs.mkdirSync(projectPath, { recursive: true });
        const generationMode = resolveCoursewareGenerationMode(
            req.body?.generationMode || tikuContext?.generationRequest?.generationMode,
        );
        const requestedRunId = String(req.body?.runId || '').trim();

        if (requestedRunId) {
            const existingRun = readCoursewareAgentRun(projectPath);
            if (!existingRun || existingRun.runId !== requestedRunId) {
                return res.status(404).json({
                    error: '未找到可恢复的课件运行',
                    runId: requestedRunId,
                    workspaceName,
                });
            }
            const result = await getTikuCoursewareOrchestrator().run({
                projectPath,
                runId: requestedRunId,
                model: req.body?.model,
                maxOutputTokens: req.body?.maxOutputTokens,
                maxVisualRepairSlides: req.body?.maxVisualRepairSlides,
                countResume: true,
            });
            return res.status(result.status === 'blocked' ? 422 : 200).json(
                coursewareApiPayload(projectPath, workspaceName, { ...result, resumed: true }),
            );
        }

        const existingPrimaryFiles = listExistingCoursewareFiles(projectPath, COURSEWARE_PRIMARY_FILES);
        const operationMode = resolveCoursewareOperationMode({
            requestedMode: req.body?.operationMode || tikuContext?.generationRequest?.operationMode,
            rebuildMode: tikuContext?.generationRequest?.rebuildMode,
            hasExistingAssets: existingPrimaryFiles.length > 0,
        });

        if (operationMode === 'audit-only' || operationMode === 'reuse-existing') {
            const slidesPackage = readJsonFileIfExists(path.join(projectPath, 'courseware-slides.json'));
            const slides = Array.isArray(slidesPackage?.slides) ? slidesPackage.slides : [];
            if (!slides.length) {
                return res.status(409).json({
                    success: false,
                    code: 'COURSEWARE_EXISTING_ASSET_REQUIRED',
                    error: `${operationMode} 需要已有 courseware-slides.json；当前工作区没有可复用主资产`,
                    operationMode,
                    workspaceName,
                    projectPath,
                });
            }
            const assetFiles = listCoursewareAssetFiles(projectPath);
            const assetPackage = createCoursewareAssetPackage(workspaceName, projectPath, assetFiles);
            const validation = await validateTongchengCoursewareWorkspace(projectPath, { publishTarget: 'learn' });
            return res.status(validation.ok ? 200 : 422).json({
                success: validation.ok,
                runId: null,
                coordinatorSessionId: null,
                currentPhase: 'review',
                completedAgents: [],
                runningAgents: [],
                blockedAgents: validation.ok ? [] : ['courseware-review'],
                reportPaths: {},
                mode: operationMode,
                operationMode,
                generationMode,
                engine: 'pilotdeck',
                degraded: false,
                degradedReason: null,
                styleApprovalRequired: false,
                teacherApprovedStyleId: null,
                visualQualityStatus: 'not-run',
                reusedExisting: true,
                status: validation.ok ? 'reviewing' : 'blocked',
                workspaceName,
                workspacePath: projectPath,
                projectPath,
                studioUrl: `/p/${encodeURIComponent(workspaceName)}`,
                coursewareSlides: slidesPackage,
                package: assetPackage,
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
                workspaceName,
                projectPath,
            });
        }

        if (operationMode === 'incremental-update') {
            return res.status(409).json({
                success: false,
                code: 'COURSEWARE_PATCH_SCOPE_REQUIRED',
                error: '增量修改必须提供经老师确认的 allowedWrites/patchScope；本接口不会把增量请求降级为整套重建',
                operationMode,
                workspaceName,
                projectPath,
            });
        }

        const runId = `cw-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
        const snapshot = operationMode === 'full-rebuild'
            ? prepareCoursewareFullRebuild(projectPath, runId)
            : { snapshotPath: null, files: [] };
        fs.writeFileSync(path.join(projectPath, 'tiku-context.json'), `${JSON.stringify(tikuContext, null, 2)}\n`);
        writeTikuGenerationRequest(projectPath, tikuContext);
        const teacherApprovedStyleId = req.body?.teacherApprovedStyleId || tikuContext?.generationRequest?.teacherApprovedStyleId || null;
        const outputTargets = req.body?.outputTargets || tikuContext?.generationRequest?.outputTargets || ['html', 'pptx'];
        const audience = req.body?.audience || tikuContext?.generationRequest?.audience || 'student';
        const budgetLimits = req.body?.budgetLimits || tikuContext?.generationRequest?.budgetLimits || null;
        writeCoursewareRunContracts({
            projectPath,
            runId,
            operationMode,
            generationMode,
            teacherApprovedStyleId,
            tikuContext,
            sourceLock: req.body?.sourceLock,
            snapshot,
            outputTargets,
            audience,
            budgetLimits,
        });
        writeRequestedApprovedStyle(projectPath, {
            runId,
            lessonId: tikuContext?.coursePackage?.lessonId || tikuContext?.lesson?.lessonId,
            teacherApprovedStyleId,
            designTokens: req.body?.designTokens || tikuContext?.generationRequest?.designTokens,
            teacherNotes: req.body?.teacherNotes,
        });

        const pipelinePromise = getTikuCoursewareOrchestrator().run({
            projectPath,
            runId,
            model: req.body?.model,
            maxOutputTokens: req.body?.maxOutputTokens,
            maxVisualRepairSlides: req.body?.maxVisualRepairSlides,
        });
        const timeoutMs = Math.max(1000, Number(req.body?.timeoutMs || process.env.TONGCHENG_COURSEWARE_AGENT_TIMEOUT_MS || 300000));
        const outcome = await Promise.race([
            pipelinePromise.then((result) => ({ result }), (error) => ({ error })),
            new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs)),
        ]);
        if (outcome.timedOut) {
            return res.status(202).json(coursewareApiPayload(projectPath, workspaceName, {
                status: 'running',
                message: '7-Agent 课件任务仍在运行，可通过状态接口读取真实阶段进度',
            }));
        }
        if (outcome.error) throw outcome.error;
        const result = outcome.result;
        if (result.status === 'blocked' && req.body?.allowTemplateFallback === true && generationMode === 'automatic-draft') {
            const slidesPackage = buildCoursewareSlidesFromTikuContext(tikuContext);
            fs.writeFileSync(path.join(projectPath, 'courseware-slides.json'), `${JSON.stringify(slidesPackage, null, 2)}\n`);
            writeTikuCoursewareDerivedFiles(projectPath, slidesPackage, tikuContext, { persistSource: false });
            updateCoursewareAgentRun(projectPath, {
                status: 'draft',
                degraded: true,
                degradedReason: 'PilotDeck 7-Agent pipeline was blocked; explicit automatic-draft template fallback was requested.',
                publish: { allowed: false, reason: 'Degraded template draft requires teacher review and cannot auto-publish.' },
            });
            return res.status(200).json(coursewareApiPayload(projectPath, workspaceName, {
                mode: 'template-fallback',
                status: 'draft',
                degraded: true,
                degradedReason: 'PilotDeck 7-Agent pipeline was blocked; explicit automatic-draft template fallback was requested.',
            }));
        }
        return res.status(result.status === 'blocked' ? 422 : 200).json(
            coursewareApiPayload(projectPath, workspaceName, result),
        );
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.get('/api/internal/legacy/tongcheng/tiku/courseware-slides/status', requireTongchengServiceToken, async (req, res) => {
    try {
        const workspaceName = safeSlug(req.query.workspaceName || req.query.workspace || '', '');
        if (!workspaceName) {
            return res.status(400).json({ error: '缺少 workspaceName' });
        }
        const workspaceRoot = path.resolve(
            process.env.TONGCHENG_ASSET_WORKSPACES_ROOT ||
            path.join(__dirname, '..', '..', 'workspaces'),
        );
        const projectPath = path.join(workspaceRoot, workspaceName);
        if (!fs.existsSync(projectPath)) {
            return res.status(404).json({ error: '未找到教研创作工作区' });
        }
        const run = readCoursewareAgentRun(projectPath);
        if (!run) {
            return res.json(buildTikuCoursewareStatus(projectPath, {
                workspaceName,
                sessionKey: String(req.query.sessionKey || req.query.session || ''),
            }));
        }
        const payload = coursewareApiPayload(projectPath, workspaceName);
        res.status(payload.status === 'blocked' ? 422 : 200).json(payload);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.post('/api/internal/legacy/tongcheng/tiku/courseware-slides/style-approval', requireTongchengServiceToken, async (req, res) => {
    try {
        const workspaceName = safeSlug(req.body?.workspaceName || '', '');
        if (!workspaceName) return res.status(400).json({ error: '缺少 workspaceName' });
        const workspaceRoot = path.resolve(process.env.TONGCHENG_ASSET_WORKSPACES_ROOT || path.join(__dirname, '..', '..', 'workspaces'));
        const projectPath = path.join(workspaceRoot, workspaceName);
        const result = await getTikuCoursewareOrchestrator().approveStyle({
            projectPath,
            runId: String(req.body?.runId || ''),
            styleId: req.body?.styleId,
            teacherNotes: req.body?.teacherNotes,
            model: req.body?.model,
        });
        return res.status(result.status === 'blocked' ? 422 : 200).json(coursewareApiPayload(projectPath, workspaceName, result));
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.post('/api/internal/legacy/tongcheng/tiku/courseware-slides/patch', requireTongchengServiceToken, async (req, res) => {
    try {
        const workspaceName = safeSlug(req.body?.workspaceName || '', '');
        if (!workspaceName) return res.status(400).json({ error: '缺少 workspaceName' });
        const workspaceRoot = path.resolve(process.env.TONGCHENG_ASSET_WORKSPACES_ROOT || path.join(__dirname, '..', '..', 'workspaces'));
        const projectPath = path.join(workspaceRoot, workspaceName);
        const result = await getTikuCoursewareOrchestrator().patchSlides({
            projectPath,
            runId: String(req.body?.runId || ''),
            patchScope: req.body?.patchScope,
            allowedWrites: req.body?.allowedWrites,
            targetSlideIds: req.body?.targetSlideIds,
            model: req.body?.model,
        });
        return res.status(result.status === 'blocked' ? 422 : 200).json(coursewareApiPayload(projectPath, workspaceName, result));
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.get('/api/tongcheng/courseware-handoff/:projectName', authenticateToken, async (req, res) => {
    try {
        const projectPath = assertCoursewareWorkspacePath(await extractProjectDirectory(req.params.projectName));
        const assetFiles = listCoursewareAssetFiles(projectPath);
        if (assetFiles.length === 0) {
            return res.status(400).json({
                error: '当前工作区没有可交接的课程资产文件',
            expectedFiles: ['brief.md', 'course-outline.md', 'teacher-script.md', 'exercises.md', 'pitfalls.md', 'courseware-slides.json', 'parent-feedback.md'],
            });
        }
        const assetPackage = createCoursewareAssetPackage(req.params.projectName, projectPath, assetFiles);
        writeCoursewareHandoffFiles(projectPath, assetPackage);
        const validation = await validateTongchengCoursewareWorkspace(projectPath, { publishTarget: 'learn' });

        const baseUrl = String(
            req.query.baseUrl ||
            process.env.TONGCHENG_OPENMAIC_COURSEWARE_URL ||
            process.env.TONGCHENG_OPENMAIC_URL ||
            process.env.TONGCHENG_COURSEWARE_URL ||
            'http://localhost:3000/courseware-pilot',
        );
        const coursePackageId = req.query.coursePackageId || assetPackage.coursePackageId;
        const lessonId = req.query.lessonId || assetPackage.lessonId;
        const teachLessonId = req.query.teachLessonId || req.query.teach_lesson_id;
        const tikuLessonId = req.query.tikuLessonId || req.query.tiku_lesson_id;
        const url = await createOpenMaicCoursewareLaunchUrl({
            baseUrl,
            query: {
                assetWorkspace: projectPath,
                subject: String(req.query.subject || resolveCoursewareSubjectFromAssets(projectPath)),
                from: 'asset-workspace',
                coursePackageId,
                lessonId,
                teachLessonId,
                tikuLessonId,
            },
            handoffToken: process.env.TONGCHENG_COURSEWARE_HANDOFF_TOKEN,
            fetchImpl: fetch,
        });

        res.json({
            success: true,
            url,
            packageId: assetPackage.packageId,
            subject: assetPackage.subject,
            topic: assetPackage.topic,
            projectPath,
            validation,
            assetFiles: [...new Set([...assetFiles, 'courseware-slides.json', 'generator-handoff.json', 'courseware-package.json'])],
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.get('/api/tongcheng/courseware-program/:projectName', authenticateToken, async (req, res) => {
    try {
        const projectPath = assertCoursewareWorkspacePath(await extractProjectDirectory(req.params.projectName));
        const status = getCoursewareProgramStatus(req.params.projectName, projectPath, {
            programId: req.query.programId,
        });
        res.json({ success: true, program: status });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.get('/api/tongcheng/courseware-progress/:projectName', authenticateToken, async (req, res) => {
    try {
        const projectPath = assertCoursewareWorkspacePath(await extractProjectDirectory(req.params.projectName));
        const progress = getCoursewareProgramProgress(req.params.projectName, projectPath, {
            programId: req.query.programId,
        });
        res.json({ success: true, progress });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.post('/api/tongcheng/courseware-program/:projectName/initialize', authenticateToken, async (req, res) => {
    try {
        const projectPath = assertCoursewareWorkspacePath(await extractProjectDirectory(req.params.projectName));
        const program = ensureCoursewareProgram(req.params.projectName, projectPath, req.body || {});
        const status = getCoursewareProgramStatus(req.params.projectName, projectPath, {
            programId: program.programId,
        });
        res.json({ success: true, program: status, manifest: program });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.post('/api/tongcheng/courseware-program/:projectName/refresh-packages', authenticateToken, async (req, res) => {
    try {
        const projectPath = assertCoursewareWorkspacePath(await extractProjectDirectory(req.params.projectName));
        const result = await refreshCoursewareProgramPackages(req.params.projectName, projectPath, {
            programId: req.query.programId,
        });
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// Rename project endpoint
app.put('/api/projects/:projectName/rename', authenticateToken, async (req, res) => {
    try {
        const { displayName } = req.body;
        await renameProject(req.params.projectName, displayName);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete session endpoint
app.delete('/api/projects/:projectName/sessions/:sessionId', authenticateToken, async (req, res) => {
    try {
        const { projectName, sessionId } = req.params;
        console.log(`[API] Deleting session: ${sessionId} from project: ${projectName}`);
        await deleteSession(projectName, sessionId, {
            sessionKind: req.query.sessionKind || null,
            parentSessionId: req.query.parentSessionId || null,
            relativeTranscriptPath: req.query.relativeTranscriptPath || null,
        });
        sessionNamesDb.deleteName(sessionId, 'pilotdeck');
        console.log(`[API] Session ${sessionId} deleted successfully`);
        res.json({ success: true });
    } catch (error) {
        console.error(`[API] Error deleting session ${req.params.sessionId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Rename session endpoint
app.put('/api/sessions/:sessionId/rename', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }
        const { summary, provider } = req.body;
        if (!summary || typeof summary !== 'string' || summary.trim() === '') {
            return res.status(400).json({ error: 'Summary is required' });
        }
        if (summary.trim().length > 500) {
            return res.status(400).json({ error: 'Summary must not exceed 500 characters' });
        }
        if (!provider || !VALID_PROVIDERS.includes(provider)) {
            return res.status(400).json({ error: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
        }
        sessionNamesDb.setName(safeSessionId, provider, summary.trim());
        res.json({ success: true });
    } catch (error) {
        console.error(`[API] Error renaming session ${req.params.sessionId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Delete project endpoint (force=true to delete with sessions)
app.delete('/api/projects/:projectName', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const force = req.query.force === 'true';
        await deleteProject(projectName, force);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create project endpoint
app.post('/api/projects/create', authenticateToken, async (req, res) => {
    try {
        const { path: projectPath } = req.body;

        if (!projectPath || !projectPath.trim()) {
            return res.status(400).json({ error: 'Project path is required' });
        }

        const project = await addProjectManually(projectPath.trim());
        res.json({ success: true, project });
    } catch (error) {
        console.error('Error creating project:', error);
        res.status(500).json({ error: error.message });
    }
});

// Search conversations content (SSE streaming)
app.get('/api/search/conversations', authenticateToken, async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const parsedLimit = Number.parseInt(String(req.query.limit), 10);
    const limit = Number.isNaN(parsedLimit) ? 50 : Math.max(1, Math.min(parsedLimit, 100));

    if (query.length < 2) {
        return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const abortController = new AbortController();
    req.on('close', () => { closed = true; abortController.abort(); });

    try {
        await searchConversations(query, limit, ({ projectResult, totalMatches, scannedProjects, totalProjects }) => {
            if (closed) return;
            if (projectResult) {
                res.write(`event: result\ndata: ${JSON.stringify({ projectResult, totalMatches, scannedProjects, totalProjects })}\n\n`);
            } else {
                res.write(`event: progress\ndata: ${JSON.stringify({ totalMatches, scannedProjects, totalProjects })}\n\n`);
            }
        }, abortController.signal);
        if (!closed) {
            res.write(`event: done\ndata: {}\n\n`);
        }
    } catch (error) {
        console.error('Error searching conversations:', error);
        if (!closed) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Search failed' })}\n\n`);
        }
    } finally {
        if (!closed) {
            res.end();
        }
    }
});

const expandWorkspacePath = (inputPath) => {
    if (!inputPath) return inputPath;
    if (inputPath === '~') {
        return WORKSPACES_ROOT;
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(WORKSPACES_ROOT, inputPath.slice(2));
    }
    return inputPath;
};

function resolvePathInProject(projectRoot, targetPath = '') {
    const resolved = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(projectRoot, targetPath);
    const normalizedRoot = path.resolve(projectRoot);

    if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
        return { valid: false, error: 'Path must be under project root' };
    }

    return { valid: true, resolved };
}

function setPreviewContentType(res, filePath) {
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const charset = mimeType.startsWith('text/') || mimeType === 'application/javascript' || mimeType === 'application/json'
        ? '; charset=utf-8'
        : '';
    res.setHeader('Content-Type', `${mimeType}${charset}`);
}

async function addDirectoryToZip(zip, directoryPath, rootPath) {
    const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
        const absolutePath = path.join(directoryPath, entry.name);
        const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join('/');

        if (!relativePath) {
            continue;
        }

        if (entry.isDirectory()) {
            zip.folder(relativePath);
            await addDirectoryToZip(zip, absolutePath, rootPath);
            continue;
        }

        if (entry.isFile()) {
            const [content, stats] = await Promise.all([
                fsPromises.readFile(absolutePath),
                fsPromises.stat(absolutePath),
            ]);
            zip.file(relativePath, content, { date: stats.mtime });
        }
    }
}

function getSafeZipFilename(projectName) {
    const safeName = String(projectName || 'project')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
        .replace(/^\.+$/, 'project')
        .trim() || 'project';
    return `${safeName}.zip`;
}

// Browse filesystem endpoint for project suggestions - uses existing getFileTree
app.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
        const { path: dirPath } = req.query;

        console.log('[API] Browse filesystem request for path:', dirPath);
        console.log('[API] WORKSPACES_ROOT is:', WORKSPACES_ROOT);
        // Default to home directory if no path provided
        const defaultRoot = WORKSPACES_ROOT;
        let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

        // Resolve and normalize the path
        targetPath = path.resolve(targetPath);

        // Browsing a directory is read-only — we only list its children.
        // The actual workspace-selection validation happens in the
        // create-workspace / clone-progress endpoints, so we don't gate
        // browsing with validateWorkspacePath (which would block navigating
        // through forbidden directories like "/" to reach valid children).
        const resolvedPath = targetPath;

        // Security check - ensure path is accessible
        try {
            await fs.promises.access(resolvedPath);
            const stats = await fs.promises.stat(resolvedPath);

            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }
        } catch (err) {
            return res.status(404).json({ error: 'Directory not accessible' });
        }

        // Use existing getFileTree function with shallow depth (only direct children)
        const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

        // Filter only directories and format for suggestions
        const directories = fileTree
            .filter(item => item.type === 'directory')
            .map(item => ({
                path: item.path,
                name: item.name,
                type: 'directory'
            }))
            .sort((a, b) => {
                const aHidden = a.name.startsWith('.');
                const bHidden = b.name.startsWith('.');
                if (aHidden && !bHidden) return 1;
                if (!aHidden && bHidden) return -1;
                return a.name.localeCompare(b.name);
            });

        // Add common directories if browsing home directory
        const suggestions = [];
        let resolvedWorkspaceRoot = defaultRoot;
        try {
            resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
        } catch (error) {
            // Use default root as-is if realpath fails
        }
        if (resolvedPath === resolvedWorkspaceRoot) {
            const commonDirs = ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'];
            const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
            const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

            suggestions.push(...existingCommon, ...otherDirs);
        } else {
            suggestions.push(...directories);
        }

        res.json({
            path: resolvedPath,
            suggestions: suggestions
        });

    } catch (error) {
        console.error('Error browsing filesystem:', error);
        res.status(500).json({ error: 'Failed to browse filesystem' });
    }
});

app.post('/api/create-folder', authenticateToken, async (req, res) => {
    try {
        const { path: folderPath } = req.body;
        if (!folderPath) {
            return res.status(400).json({ error: 'Path is required' });
        }
        const expandedPath = expandWorkspacePath(folderPath);
        const resolvedInput = path.resolve(expandedPath);
        const validation = await validateWorkspacePath(resolvedInput);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const targetPath = validation.resolvedPath || resolvedInput;
        const parentDir = path.dirname(targetPath);
        try {
            await fs.promises.access(parentDir);
        } catch (err) {
            return res.status(404).json({ error: 'Parent directory does not exist' });
        }
        try {
            await fs.promises.access(targetPath);
            return res.status(409).json({ error: 'Folder already exists' });
        } catch (err) {
            // Folder doesn't exist, which is what we want
        }
        try {
            await fs.promises.mkdir(targetPath, { recursive: false });
            res.json({ success: true, path: targetPath });
        } catch (mkdirError) {
            if (mkdirError.code === 'EEXIST') {
                return res.status(409).json({ error: 'Folder already exists' });
            }
            throw mkdirError;
        }
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// Read file content endpoint
app.get('/api/projects/:projectName/file', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Handle both absolute and relative paths
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        const content = await fsPromises.readFile(resolved, 'utf8');
        res.json({ content, path: resolved });
    } catch (error) {
        console.error('Error reading file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Serve raw file bytes for previews and downloads.
app.get('/api/projects/:projectName/files/content', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { path: filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Match the text reader endpoint so callers can pass either project-relative
        // or absolute paths without changing how the bytes are served.
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Check if file exists
        try {
            await fsPromises.access(resolved);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Get file extension and set appropriate content type
        const mimeType = mime.lookup(resolved) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);

        if (req.query.download) {
            const basename = path.basename(resolved);
            res.setHeader('Content-Disposition', contentDispositionAttachment(basename));
        }

        // Stream the file
        const fileStream = fs.createReadStream(resolved);
        fileStream.pipe(res);

        fileStream.on('error', (error) => {
            console.error('Error streaming file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading file' });
            }
        });

    } catch (error) {
        console.error('Error serving binary file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Serve project files through a stable project-root URL so generated HTML can
// load sibling CSS, JS and image assets with normal relative paths.
app.get('/api/projects/:projectName/preview/*', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const relativeFilePath = req.params[0] || 'index.html';

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const resolvedResult = resolvePathInProject(projectRoot, relativeFilePath);
        if (!resolvedResult.valid) {
            return res.status(403).json({ error: resolvedResult.error });
        }

        let resolved = resolvedResult.resolved;
        let stats = await fsPromises.stat(resolved).catch(() => null);
        if (stats?.isDirectory()) {
            resolved = path.join(resolved, 'index.html');
            stats = await fsPromises.stat(resolved).catch(() => null);
        }

        if (!stats || !stats.isFile()) {
            return res.status(404).type('text/plain').send('Preview file not found.');
        }

        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        setPreviewContentType(res, resolved);
        fs.createReadStream(resolved).pipe(res);
    } catch (error) {
        console.error('Error serving project preview:', error);
        res.status(500).json({ error: error.message });
    }
});

// Download the complete project as a zip archive.
app.get('/api/projects/:projectName/download', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const rootStats = await fsPromises.stat(projectRoot).catch(() => null);
        if (!rootStats?.isDirectory()) {
            return res.status(404).json({ error: 'Project directory not found' });
        }

        const zip = new JSZip();
        await addDirectoryToZip(zip, projectRoot, projectRoot);

        const filename = getSafeZipFilename(projectName);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', contentDispositionAttachment(filename));

        const zipStream = zip.generateNodeStream({
            type: 'nodebuffer',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
        });
        zipStream.on('error', (error) => {
            console.error('Error streaming project zip:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to generate project archive' });
            } else {
                res.end();
            }
        });
        zipStream.pipe(res);
    } catch (error) {
        console.error('Error downloading project archive:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Save file content endpoint
app.put('/api/projects/:projectName/file', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { filePath, content } = req.body;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (content === undefined) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Handle both absolute and relative paths
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Write the new content
        await fsPromises.writeFile(resolved, content, 'utf8');

        res.json({
            success: true,
            path: resolved,
            message: 'File saved successfully'
        });
    } catch (error) {
        console.error('Error saving file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/api/projects/:projectName/files', authenticateToken, async (req, res) => {
    try {

        // Using fsPromises from import

        // Use extractProjectDirectory to get the actual project path
        let actualPath;
        try {
            actualPath = await extractProjectDirectory(req.params.projectName);
        } catch (error) {
            console.error('Error extracting project directory:', error);
            // Fallback to simple dash replacement
            actualPath = req.params.projectName.replace(/-/g, '/');
        }

        // Check if path exists
        try {
            await fsPromises.access(actualPath);
        } catch (e) {
            return res.status(404).json({ error: `Project path not found: ${actualPath}` });
        }

        const files = await getFileTree(actualPath, 10, 0, true);
        res.json(files);
    } catch (error) {
        console.error('[ERROR] File tree error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// FILE OPERATIONS API ENDPOINTS
// ============================================================================

/**
 * Validate that a path is within the project root
 * @param {string} projectRoot - The project root path
 * @param {string} targetPath - The path to validate
 * @returns {{ valid: boolean, resolved?: string, error?: string }}
 */
function validatePathInProject(projectRoot, targetPath) {
    const resolved = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(projectRoot, targetPath);
    const normalizedRoot = path.resolve(projectRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot)) {
        return { valid: false, error: 'Path must be under project root' };
    }
    return { valid: true, resolved };
}

/**
 * Validate filename - check for invalid characters
 * @param {string} name - The filename to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFilename(name) {
    if (!name || !name.trim()) {
        return { valid: false, error: 'Filename cannot be empty' };
    }
    // Check for invalid characters (Windows + Unix)
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(name)) {
        return { valid: false, error: 'Filename contains invalid characters' };
    }
    // Check for reserved names (Windows)
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reserved.test(name)) {
        return { valid: false, error: 'Filename is a reserved name' };
    }
    // Check for dots only
    if (/^\.+$/.test(name)) {
        return { valid: false, error: 'Filename cannot be only dots' };
    }
    return { valid: true };
}

// POST /api/projects/:projectName/files/create - Create new file or directory
app.post('/api/projects/:projectName/files/create', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { path: parentPath, type, name } = req.body;

        // Validate input
        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }

        if (!['file', 'directory'].includes(type)) {
            return res.status(400).json({ error: 'Type must be "file" or "directory"' });
        }

        const nameValidation = validateFilename(name);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Get project root
        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Build and validate target path
        const targetDir = parentPath || '';
        const targetPath = targetDir ? path.join(targetDir, name) : name;
        const validation = validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if already exists
        try {
            await fsPromises.access(resolvedPath);
            return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Create file or directory
        if (type === 'directory') {
            await fsPromises.mkdir(resolvedPath, { recursive: false });
        } else {
            // Ensure parent directory exists
            const parentDir = path.dirname(resolvedPath);
            try {
                await fsPromises.access(parentDir);
            } catch {
                await fsPromises.mkdir(parentDir, { recursive: true });
            }
            await fsPromises.writeFile(resolvedPath, '', 'utf8');
        }

        res.json({
            success: true,
            path: resolvedPath,
            name,
            type,
            message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
        });
    } catch (error) {
        console.error('Error creating file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'Parent directory not found' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// PUT /api/projects/:projectName/files/rename - Rename file or directory
app.put('/api/projects/:projectName/files/rename', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { oldPath, newName } = req.body;

        // Validate input
        if (!oldPath || !newName) {
            return res.status(400).json({ error: 'oldPath and newName are required' });
        }

        const nameValidation = validateFilename(newName);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Get project root
        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Validate old path
        const oldValidation = validatePathInProject(projectRoot, oldPath);
        if (!oldValidation.valid) {
            return res.status(403).json({ error: oldValidation.error });
        }

        const resolvedOldPath = oldValidation.resolved;

        // Check if old path exists
        try {
            await fsPromises.access(resolvedOldPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Build and validate new path
        const parentDir = path.dirname(resolvedOldPath);
        const resolvedNewPath = path.join(parentDir, newName);
        const newValidation = validatePathInProject(projectRoot, resolvedNewPath);
        if (!newValidation.valid) {
            return res.status(403).json({ error: newValidation.error });
        }

        // Check if new path already exists
        try {
            await fsPromises.access(resolvedNewPath);
            return res.status(409).json({ error: 'A file or directory with this name already exists' });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Rename
        await fsPromises.rename(resolvedOldPath, resolvedNewPath);

        res.json({
            success: true,
            oldPath: resolvedOldPath,
            newPath: resolvedNewPath,
            newName,
            message: 'Renamed successfully'
        });
    } catch (error) {
        console.error('Error renaming file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EXDEV') {
            res.status(400).json({ error: 'Cannot move across different filesystems' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// DELETE /api/projects/:projectName/files - Delete file or directory
app.delete('/api/projects/:projectName/files', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { path: targetPath, type } = req.body;

        // Validate input
        if (!targetPath) {
            return res.status(400).json({ error: 'Path is required' });
        }

        // Get project root
        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Validate path
        const validation = validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if path exists and get stats
        let stats;
        try {
            stats = await fsPromises.stat(resolvedPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Prevent deleting the project root itself
        if (resolvedPath === path.resolve(projectRoot)) {
            return res.status(403).json({ error: 'Cannot delete project root directory' });
        }

        // Delete based on type
        if (stats.isDirectory()) {
            await fsPromises.rm(resolvedPath, { recursive: true, force: true });
        } else {
            await fsPromises.unlink(resolvedPath);
        }

        res.json({
            success: true,
            path: resolvedPath,
            type: stats.isDirectory() ? 'directory' : 'file',
            message: 'Deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'ENOTEMPTY') {
            res.status(400).json({ error: 'Directory is not empty' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// POST /api/projects/:projectName/files/upload - Upload files
// Dynamic import of multer for file uploads
const uploadFilesHandler = async (req, res) => {
    // Dynamic import of multer
    const multer = (await import('multer')).default;

    const uploadMiddleware = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                cb(null, os.tmpdir());
            },
            filename: (req, file, cb) => {
                // Use a unique temp name, but preserve original name in file.originalname
                // Note: file.originalname may contain path separators for folder uploads
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                // For temp file, just use a safe unique name without the path
                cb(null, `upload-${uniqueSuffix}`);
            }
        }),
        limits: {
            fileSize: 50 * 1024 * 1024, // 50MB limit
            files: 20 // Max 20 files at once
        }
    });

    // Use multer middleware
    uploadMiddleware.array('files', 20)(req, res, async (err) => {
        if (err) {
            console.error('Multer error:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ error: 'Too many files. Maximum is 20 files.' });
            }
            return res.status(500).json({ error: err.message });
        }

        try {
            const { projectName } = req.params;
            const { targetPath, relativePaths } = req.body;

            // Parse relative paths if provided (for folder uploads)
            let filePaths = [];
            if (relativePaths) {
                try {
                    filePaths = JSON.parse(relativePaths);
                } catch (e) {
                    console.log('[DEBUG] Failed to parse relativePaths:', relativePaths);
                }
            }

            console.log('[DEBUG] File upload request:', {
                projectName,
                targetPath: JSON.stringify(targetPath),
                targetPathType: typeof targetPath,
                filesCount: req.files?.length,
                relativePaths: filePaths
            });

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files provided' });
            }

            // Get project root
            const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            console.log('[DEBUG] Project root:', projectRoot);

            // Validate and resolve target path
            // If targetPath is empty or '.', use project root directly
            const targetDir = targetPath || '';
            let resolvedTargetDir;

            console.log('[DEBUG] Target dir:', JSON.stringify(targetDir));

            if (!targetDir || targetDir === '.' || targetDir === './') {
                // Empty path means upload to project root
                resolvedTargetDir = path.resolve(projectRoot);
                console.log('[DEBUG] Using project root as target:', resolvedTargetDir);
            } else {
                const validation = validatePathInProject(projectRoot, targetDir);
                if (!validation.valid) {
                    console.log('[DEBUG] Path validation failed:', validation.error);
                    return res.status(403).json({ error: validation.error });
                }
                resolvedTargetDir = validation.resolved;
                console.log('[DEBUG] Resolved target dir:', resolvedTargetDir);
            }

            // Ensure target directory exists
            try {
                await fsPromises.access(resolvedTargetDir);
            } catch {
                await fsPromises.mkdir(resolvedTargetDir, { recursive: true });
            }

            // Move uploaded files from temp to target directory
            const uploadedFiles = [];
            console.log('[DEBUG] Processing files:', req.files.map(f => ({ originalname: f.originalname, path: f.path })));
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                // Use relative path if provided (for folder uploads), otherwise use originalname
                const fileName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
                console.log('[DEBUG] Processing file:', fileName, '(originalname:', file.originalname + ')');
                const destPath = path.join(resolvedTargetDir, fileName);

                // Validate destination path
                const destValidation = validatePathInProject(projectRoot, destPath);
                if (!destValidation.valid) {
                    console.log('[DEBUG] Destination validation failed for:', destPath);
                    // Clean up temp file
                    await fsPromises.unlink(file.path).catch(() => {});
                    continue;
                }

                // Ensure parent directory exists (for nested files from folder upload)
                const parentDir = path.dirname(destPath);
                try {
                    await fsPromises.access(parentDir);
                } catch {
                    await fsPromises.mkdir(parentDir, { recursive: true });
                }

                // Move file (copy + unlink to handle cross-device scenarios)
                await fsPromises.copyFile(file.path, destPath);
                await fsPromises.unlink(file.path);

                uploadedFiles.push({
                    name: fileName,
                    path: destPath,
                    size: file.size,
                    mimeType: file.mimetype
                });
            }

            res.json({
                success: true,
                files: uploadedFiles,
                targetPath: resolvedTargetDir,
                message: `Uploaded ${uploadedFiles.length} file(s) successfully`
            });
        } catch (error) {
            console.error('Error uploading files:', error);
            // Clean up any remaining temp files
            if (req.files) {
                for (const file of req.files) {
                    await fsPromises.unlink(file.path).catch(() => {});
                }
            }
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });
};

app.post('/api/projects/:projectName/files/upload', authenticateToken, uploadFilesHandler);

/**
 * Proxy an authenticated client WebSocket to a plugin's internal WS server.
 * Auth is enforced by verifyClient before this function is reached.
 */
function handlePluginWsProxy(clientWs, pathname) {
    const pluginName = pathname.replace('/plugin-ws/', '');
    if (!pluginName || /[^a-zA-Z0-9_-]/.test(pluginName)) {
        clientWs.close(4400, 'Invalid plugin name');
        return;
    }

    const port = getPluginPort(pluginName);
    if (!port) {
        clientWs.close(4404, 'Plugin not running');
        return;
    }

    const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    upstream.on('open', () => {
        console.log(`[Plugins] WS proxy connected to "${pluginName}" on port ${port}`);
    });

    // Relay messages bidirectionally
    upstream.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
    });
    clientWs.on('message', (data) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
    });

    // Propagate close in both directions
    upstream.on('close', () => { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(); });
    clientWs.on('close', () => { if (upstream.readyState === WebSocket.OPEN) upstream.close(); });

    upstream.on('error', (err) => {
        console.error(`[Plugins] WS proxy error for "${pluginName}":`, err.message);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(4502, 'Upstream error');
    });
    clientWs.on('error', () => {
        if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });
}

// WebSocket connection handler that routes based on URL path
wss.on('connection', (ws, request) => {
    const url = request.url;
    console.log('[INFO] Client connected to:', url);

    // Parse URL to get pathname without query parameters
    const urlObj = new URL(url, 'http://localhost');
    const pathname = urlObj.pathname;

    if (pathname === '/shell') {
        handleShellConnection(ws);
    } else if (pathname === '/ws') {
        handleChatConnection(ws, request);
    } else if (pathname.startsWith('/plugin-ws/')) {
        handlePluginWsProxy(ws, pathname);
    } else {
        console.log('[WARN] Unknown WebSocket path:', pathname);
        ws.close();
    }
});

/**
 * WebSocket Writer - Wrapper for WebSocket to match SSEStreamWriter interface
 *
 * Provider files use `createNormalizedMessage()` from `providers/types.js` and
 * adapter `normalizeMessage()` to produce unified NormalizedMessage events.
 * The writer simply serialises and sends.
 */
class WebSocketWriter {
    constructor(ws, userId = null) {
        this.ws = ws;
        this.sessionId = null;
        this.userId = userId;
        this.isWebSocketWriter = true;  // Marker for transport detection
    }

    send(data) {
        const message = JSON.stringify(data);
        if (this.ws.readyState === 1) { // WebSocket.OPEN
            this.ws.send(message);
            return;
        }

        // A chat turn can outlive the browser WebSocket that submitted it
        // (refresh, reconnect, dev-client hiccup). Keep the gateway stream live
        // by handing subsequent frames to the user's replacement connection.
        connectedClients.forEach((client) => {
            if (client.readyState !== 1) return; // WebSocket.OPEN
            if (client.__pilotdeckUserId !== this.userId) return;
            client.send(message);
        });
    }

    updateWebSocket(newRawWs) {
        this.ws = newRawWs;
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    getSessionId() {
        return this.sessionId;
    }
}

// Handle chat WebSocket connections
function handleChatConnection(ws, request) {
    console.log('[INFO] Chat WebSocket connected');

    // Add to connected clients for project updates
    const userId = request?.user?.id ?? request?.user?.userId ?? null;
    ws.__pilotdeckUserId = userId;
    connectedClients.add(ws);
    // PilotDeck's cron runtime lives inside `pilotdeck server`
    // (src/cron via createCronRuntime); no legacy daemon lease needed.
    let cleanedUp = false;

    // Wrap WebSocket with writer for consistent interface with SSEStreamWriter
    const writer = new WebSocketWriter(ws, userId);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'ping') return;

            if (data.type === 'always-on-presence') {
                await alwaysOnHeartbeat.handlePresence(ws, data);
            } else if (data.type === 'always-on-presence-clear') {
                await alwaysOnHeartbeat.clearPresence(ws);
            } else if (
                data.type === 'pilotdeck-command' ||
                // Deprecated: legacy per-provider frame types kept for back-compat.
                data.type === 'claude-command' ||
                data.type === 'cursor-command' ||
                data.type === 'codex-command' ||
                data.type === 'gemini-command'
            ) {
                console.log('[DEBUG] User message:', data.command || '[Continue/Resume]');
                console.log('📁 Project:', data.options?.projectPath || data.options?.cwd || 'Unknown');
                console.log('🔄 Session:', data.options?.sessionId ? 'Resume' : 'New');
                const providerHint = data.options?.providerHint || data.type.replace('-command', '');
                await runChatViaGateway(data.command, data.options, writer, providerHint);
            } else if (data.type === 'abort-session') {
                console.log('[DEBUG] Abort session request:', data.sessionId);
                const provider = data.provider || 'pilotdeck';
                const success = await abortViaGateway(data.sessionId, provider);
                writer.send(createNormalizedMessage({ kind: 'complete', exitCode: success ? 0 : 1, aborted: true, success, sessionId: data.sessionId, provider }));
            } else if (data.type === 'permission-response') {
                if (data.requestId) {
                    await decidePermissionViaGateway(
                        data.requestId,
                        data.allow ? 'allow' : 'deny',
                        {
                            remember: Boolean(data.rememberEntry),
                            reason: data.message,
                        },
                    );
                }
            } else if (data.type === 'session-permission-grant') {
                await grantSessionPermissionViaGateway(data.sessionId, data.entry);
            } else if (data.type === 'elicitation-response') {
                if (data.requestId) {
                    await elicitationRespondViaGateway(data.requestId, data.answer);
                }
            } else if (data.type === 'check-session-status') {
                const sessionId = data.sessionId;
                const isProcessing = isSessionActiveViaGateway(sessionId);
                const activeTurnMessages = isProcessing
                    ? await getActiveTurnSnapshotFramesViaGateway(sessionId, data.provider || 'pilotdeck')
                    : [];
                writer.send({
                    type: 'session-status',
                    sessionId,
                    provider: data.provider || 'pilotdeck',
                    isProcessing,
                    activeTurnMessages,
                    tokenBudget: getSessionTokenBudget(sessionId),
                });
            } else if (data.type === 'get-pending-permissions') {
                // Pending-permission introspection is gateway-internal. The
                // permission_request event already contains everything the
                // UI needs, so the response is now an empty stub.
                writer.send({
                    type: 'pending-permissions-response',
                    sessionId: data.sessionId,
                    data: [],
                });
            } else if (data.type === 'get-active-sessions') {
                const ids = getActiveSessionIdsViaGateway();
                // Keep the four-provider keys so the legacy UI store does
                // not need to change shape; everything routes through
                // PilotDeck under the hood.
                writer.send({
                    type: 'active-sessions',
                    sessions: { claude: ids, cursor: [], codex: [], gemini: [], pilotdeck: ids },
                });
            }
        } catch (error) {
            console.error('[ERROR] Chat WebSocket error:', error.message);
            writer.send({
                type: 'error',
                error: error.message
            });
        }
    });

    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        // Remove from connected clients
        connectedClients.delete(ws);
        void alwaysOnHeartbeat.clearPresence(ws);
    };

    ws.on('close', (code, reason) => {
        const reasonText = reason?.toString?.() || '';
        console.log(`🔌 Chat client disconnected code=${code}${reasonText ? ` reason=${reasonText}` : ''}`);
        cleanup();
    });
    ws.on('error', () => {
        cleanup();
    });
}

// Handle shell WebSocket connections
function handleShellConnection(ws) {
    console.log('🐚 Shell client connected');
    let shellProcess = null;
    let ptySessionKey = null;
    let urlDetectionBuffer = '';
    const announcedAuthUrls = new Set();

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Shell message received:', data.type);

            if (data.type === 'init') {
                const projectPath = data.projectPath || process.cwd();
                const sessionId = data.sessionId;
                const hasSession = data.hasSession;
                const provider = data.provider || 'pilotdeck';
                const initialCommand = data.initialCommand;
                const isPlainShell = data.isPlainShell || (!!initialCommand && !hasSession) || provider === 'plain-shell';
                urlDetectionBuffer = '';
                announcedAuthUrls.clear();

                const isLoginCommand = initialCommand && (
                    initialCommand.includes('setup-token') ||
                    initialCommand.includes('cursor-agent login') ||
                    initialCommand.includes('auth login')
                );

                // Include command hash in session key so different commands get separate sessions
                const commandSuffix = isPlainShell && initialCommand
                    ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
                    : '';
                ptySessionKey = `${projectPath}_${sessionId || 'default'}${commandSuffix}`;

                // Kill any existing login session before starting fresh
                if (isLoginCommand) {
                    const oldSession = ptySessionsMap.get(ptySessionKey);
                    if (oldSession) {
                        console.log('🧹 Cleaning up existing login session:', ptySessionKey);
                        if (oldSession.timeoutId) clearTimeout(oldSession.timeoutId);
                        if (oldSession.pty && oldSession.pty.kill) oldSession.pty.kill();
                        ptySessionsMap.delete(ptySessionKey);
                    }
                }

                const existingSession = isLoginCommand ? null : ptySessionsMap.get(ptySessionKey);
                if (existingSession) {
                    console.log('♻️  Reconnecting to existing PTY session:', ptySessionKey);
                    shellProcess = existingSession.pty;

                    clearTimeout(existingSession.timeoutId);

                    ws.send(JSON.stringify({
                        type: 'output',
                        data: `\x1b[36m[Reconnected to existing session]\x1b[0m\r\n`
                    }));

                    if (existingSession.buffer && existingSession.buffer.length > 0) {
                        console.log(`📜 Sending ${existingSession.buffer.length} buffered messages`);
                        existingSession.buffer.forEach(bufferedData => {
                            ws.send(JSON.stringify({
                                type: 'output',
                                data: bufferedData
                            }));
                        });
                    }

                    existingSession.ws = ws;

                    return;
                }

                console.log('[INFO] Starting shell in:', projectPath);
                console.log('📋 Session info:', hasSession ? `Resume session ${sessionId}` : (isPlainShell ? 'Plain shell mode' : 'New session'));
                console.log('🤖 Provider:', isPlainShell ? 'plain-shell' : provider);
                if (initialCommand) {
                    console.log('⚡ Initial command:', initialCommand);
                }

                // First send a welcome message
                let welcomeMsg;
                if (isPlainShell) {
                    welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
                } else {
                    const providerName = provider === 'pilotdeck' ? 'PilotDeck' : (provider === 'cursor' ? 'Cursor' : (provider === 'codex' ? 'Codex' : (provider === 'gemini' ? 'Gemini' : 'Claude')));
                    welcomeMsg = hasSession ?
                        `\x1b[36mResuming ${providerName} session ${sessionId} in: ${projectPath}\x1b[0m\r\n` :
                        `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
                }

                ws.send(JSON.stringify({
                    type: 'output',
                    data: welcomeMsg
                }));

                try {
                    // Validate projectPath — resolve to absolute and verify it exists
                    const resolvedProjectPath = path.resolve(projectPath);
                    try {
                        const stats = fs.statSync(resolvedProjectPath);
                        if (!stats.isDirectory()) {
                            throw new Error('Not a directory');
                        }
                    } catch (pathErr) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
                        return;
                    }

                    // Validate sessionId — only allow safe characters
                    const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
                    if (sessionId && !safeSessionIdPattern.test(sessionId)) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
                        return;
                    }

                    // Build shell command — use cwd for project path (never interpolate into shell string)
                    let shellCommand;
                    if (isPlainShell) {
                        // Plain shell mode - run the initial command in the project directory
                        shellCommand = initialCommand;
                    } else if (provider === 'cursor') {
                        if (hasSession && sessionId) {
                            shellCommand = `cursor-agent --resume="${sessionId}"`;
                        } else {
                            shellCommand = 'cursor-agent';
                        }
                    } else if (provider === 'codex') {
                        // Use codex command; attempt to resume and fall back to a new session when the resume fails.
                        if (hasSession && sessionId) {
                            if (os.platform() === 'win32') {
                                // PowerShell syntax for fallback
                                shellCommand = `codex resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
                            } else {
                                shellCommand = `codex resume "${sessionId}" || codex`;
                            }
                        } else {
                            shellCommand = 'codex';
                        }
                    } else if (provider === 'gemini') {
                        const command = initialCommand || 'gemini';
                        let resumeId = sessionId;
                        if (hasSession && sessionId) {
                            try {
                                // Gemini CLI enforces its own native session IDs, unlike other agents that accept arbitrary string names.
                                // The UI only knows about its internal generated `sessionId` (e.g. gemini_1234).
                                // We must fetch the mapping from the backend session manager to pass the native `cliSessionId` to the shell.
                                const sess = sessionManager.getSession(sessionId);
                                if (sess && sess.cliSessionId) {
                                    resumeId = sess.cliSessionId;
                                    // Validate the looked-up CLI session ID too
                                    if (!safeSessionIdPattern.test(resumeId)) {
                                        resumeId = null;
                                    }
                                }
                            } catch (err) {
                                console.error('Failed to get Gemini CLI session ID:', err);
                            }
                        }

                        if (hasSession && resumeId) {
                            shellCommand = `${command} --resume "${resumeId}"`;
                        } else {
                            shellCommand = command;
                        }
                    } else if (provider === 'pilotdeck') {
                        const command = initialCommand || 'pilotdeck';
                        if (hasSession && sessionId) {
                            if (os.platform() === 'win32') {
                                shellCommand = `pilotdeck --resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { pilotdeck }`;
                            } else {
                                shellCommand = `pilotdeck --resume "${sessionId}" || pilotdeck`;
                            }
                        } else {
                            shellCommand = command;
                        }
                    } else {
                        const command = initialCommand || 'claude';
                        if (hasSession && sessionId) {
                            if (os.platform() === 'win32') {
                                shellCommand = `claude --resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { claude }`;
                            } else {
                                shellCommand = `claude --resume "${sessionId}" || claude`;
                            }
                        } else {
                            shellCommand = command;
                        }
                    }

                    console.log('🔧 Executing shell command:', shellCommand);

                    // Use appropriate shell based on platform
                    const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
                    const shellArgs = os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];

                    // Use terminal dimensions from client if provided, otherwise use defaults
                    const termCols = data.cols || 80;
                    const termRows = data.rows || 24;
                    console.log('📐 Using terminal dimensions:', termCols, 'x', termRows);

                    shellProcess = pty.spawn(shell, shellArgs, {
                        name: 'xterm-256color',
                        cols: termCols,
                        rows: termRows,
                        cwd: resolvedProjectPath,
                        env: {
                            ...process.env,
                            TERM: 'xterm-256color',
                            COLORTERM: 'truecolor',
                            FORCE_COLOR: '3'
                        }
                    });

                    console.log('🟢 Shell process started with PTY, PID:', shellProcess.pid);

                    ptySessionsMap.set(ptySessionKey, {
                        pty: shellProcess,
                        ws: ws,
                        buffer: [],
                        timeoutId: null,
                        projectPath,
                        sessionId
                    });

                    // Handle data output
                    shellProcess.onData((data) => {
                        const session = ptySessionsMap.get(ptySessionKey);
                        if (!session) return;

                        if (session.buffer.length < 5000) {
                            session.buffer.push(data);
                        } else {
                            session.buffer.shift();
                            session.buffer.push(data);
                        }

                        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                            let outputData = data;

                            const cleanChunk = stripAnsiSequences(data);
                            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

                            outputData = outputData.replace(
                                /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
                                '[INFO] Opening in browser: $1'
                            );

                            const emitAuthUrl = (detectedUrl, autoOpen = false) => {
                                const normalizedUrl = normalizeDetectedUrl(detectedUrl);
                                if (!normalizedUrl) return;

                                const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
                                if (isNewUrl) {
                                    announcedAuthUrls.add(normalizedUrl);
                                    session.ws.send(JSON.stringify({
                                        type: 'auth_url',
                                        url: normalizedUrl,
                                        autoOpen
                                    }));
                                }

                            };

                            const normalizedDetectedUrls = extractUrlsFromText(urlDetectionBuffer)
                                .map((url) => normalizeDetectedUrl(url))
                                .filter(Boolean);

                            // Prefer the most complete URL if shorter prefix variants are also present.
                            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter((url, _, urls) =>
                                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
                            );

                            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

                            if (shouldAutoOpenUrlFromOutput(cleanChunk) && dedupedDetectedUrls.length > 0) {
                                const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                                    current.length > longest.length ? current : longest
                                );
                                emitAuthUrl(bestUrl, true);
                            }

                            // Send regular output
                            session.ws.send(JSON.stringify({
                                type: 'output',
                                data: outputData
                            }));
                        }
                    });

                    // Handle process exit
                    shellProcess.onExit((exitCode) => {
                        console.log('🔚 Shell process exited with code:', exitCode.exitCode, 'signal:', exitCode.signal);
                        const session = ptySessionsMap.get(ptySessionKey);
                        if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
                            session.ws.send(JSON.stringify({
                                type: 'output',
                                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${exitCode.signal ? ` (${exitCode.signal})` : ''}\x1b[0m\r\n`
                            }));
                        }
                        if (session && session.timeoutId) {
                            clearTimeout(session.timeoutId);
                        }
                        ptySessionsMap.delete(ptySessionKey);
                        shellProcess = null;
                    });

                } catch (spawnError) {
                    console.error('[ERROR] Error spawning process:', spawnError);
                    ws.send(JSON.stringify({
                        type: 'output',
                        data: `\r\n\x1b[31mError: ${spawnError.message}\x1b[0m\r\n`
                    }));
                }

            } else if (data.type === 'input') {
                // Send input to shell process
                if (shellProcess && shellProcess.write) {
                    try {
                        shellProcess.write(data.data);
                    } catch (error) {
                        console.error('Error writing to shell:', error);
                    }
                } else {
                    console.warn('No active shell process to send input to');
                }
            } else if (data.type === 'resize') {
                // Handle terminal resize
                if (shellProcess && shellProcess.resize) {
                    console.log('Terminal resize requested:', data.cols, 'x', data.rows);
                    shellProcess.resize(data.cols, data.rows);
                }
            }
        } catch (error) {
            console.error('[ERROR] Shell WebSocket error:', error.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'output',
                    data: `\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`
                }));
            }
        }
    });

    ws.on('close', () => {
        console.log('🔌 Shell client disconnected');

        if (ptySessionKey) {
            const session = ptySessionsMap.get(ptySessionKey);
            if (session) {
                console.log('⏳ PTY session kept alive, will timeout in 30 minutes:', ptySessionKey);
                session.ws = null;

                session.timeoutId = setTimeout(() => {
                    console.log('⏰ PTY session timeout, killing process:', ptySessionKey);
                    if (session.pty && session.pty.kill) {
                        session.pty.kill();
                    }
                    ptySessionsMap.delete(ptySessionKey);
                }, PTY_SESSION_TIMEOUT);
            }
        }
    });

    ws.on('error', (error) => {
        console.error('[ERROR] Shell WebSocket error:', error);
    });
}

const CHAT_ATTACHMENT_IMAGE_MIMES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
]);

function sanitizeAttachmentFilename(name, fallback = 'attachment') {
    const baseName = path.basename(String(name || fallback));
    const sanitized = baseName
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/^\.+$/, fallback)
        .slice(0, 180)
        .trim();
    return sanitized || fallback;
}

function normalizeUploadedFilename(name, fallback = 'attachment') {
    const original = String(name || fallback);
    try {
        const decoded = Buffer.from(original, 'latin1').toString('utf8');
        const looksMojibake = /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùûüýþÿ]/.test(original);
        if (looksMojibake && decoded && !decoded.includes('�')) {
            return decoded;
        }
    } catch {
        // Keep the browser-provided name when transcoding is not applicable.
    }
    return original;
}

async function moveUploadedAttachment(file, attachmentDir, index) {
    const originalName = normalizeUploadedFilename(file.originalname, `attachment-${index + 1}`);
    file.originalname = originalName;
    const safeName = sanitizeAttachmentFilename(originalName, `attachment-${index + 1}`);
    const ext = path.extname(safeName);
    const stem = ext ? safeName.slice(0, -ext.length) : safeName;
    let candidate = `${index + 1}-${safeName}`;
    let destination = path.join(attachmentDir, candidate);
    let suffix = 1;
    while (true) {
        try {
            await fsPromises.access(destination);
            candidate = `${index + 1}-${stem}-${suffix}${ext}`;
            destination = path.join(attachmentDir, candidate);
            suffix += 1;
        } catch {
            break;
        }
    }

    await fsPromises.copyFile(file.path, destination);
    await fsPromises.unlink(file.path);
    return {
        name: originalName,
        path: destination,
        size: file.size,
        mimeType: file.mimetype || mime.lookup(originalName) || 'application/octet-stream',
    };
}

// Mixed chat attachment upload endpoint. Images are returned as data URLs for
// multimodal input and previews; other files are staged under the project so
// the gateway can resolve them by path.
app.post('/api/projects/:projectName/upload-attachments', authenticateToken, async (req, res) => {
    let multerUpload;
    try {
        const multer = (await import('multer')).default;
        const uploadRoot = path.join(os.tmpdir(), 'pilotdeck-chat-attachments', String(req.user.id));
        const storage = multer.diskStorage({
            destination: async (_req, _file, cb) => {
                try {
                    await fsPromises.mkdir(uploadRoot, { recursive: true });
                    cb(null, uploadRoot);
                } catch (error) {
                    cb(error);
                }
            },
            filename: (_req, file, cb) => {
                const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
                file.originalname = normalizeUploadedFilename(file.originalname);
                cb(null, `${uniqueSuffix}-${sanitizeAttachmentFilename(file.originalname)}`);
            },
        });

        multerUpload = multer({
            storage,
            limits: {
                fileSize: 20 * 1024 * 1024,
                files: 10,
            },
        }).array('attachments', 10);
    } catch (error) {
        console.error('Error configuring attachment upload:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }

    multerUpload(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No attachments provided' });
        }

        let attachmentDir = null;
        try {
            const projectRoot = await extractProjectDirectory(req.params.projectName);
            const targetDir = path.join(projectRoot, '.tmp', 'chat-attachments', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
            const validation = validatePathInProject(projectRoot, targetDir);
            if (!validation.valid) {
                throw new Error(validation.error || 'Invalid attachment target');
            }
            attachmentDir = validation.resolved;

            const images = [];
            const files = [];
            await fsPromises.mkdir(attachmentDir, { recursive: true });

            for (const [index, file] of req.files.entries()) {
                if (CHAT_ATTACHMENT_IMAGE_MIMES.has(file.mimetype)) {
                    const originalName = normalizeUploadedFilename(file.originalname);
                    const buffer = await fsPromises.readFile(file.path);
                    await fsPromises.unlink(file.path).catch(() => { });
                    images.push({
                        name: originalName,
                        data: `data:${file.mimetype};base64,${buffer.toString('base64')}`,
                        size: file.size,
                        mimeType: file.mimetype,
                    });
                    continue;
                }

                files.push(await moveUploadedAttachment(file, attachmentDir, index));
            }

            if (files.length === 0 && attachmentDir) {
                await fsPromises.rm(attachmentDir, { recursive: true, force: true }).catch(() => { });
            }

            res.json({ images, files });
        } catch (error) {
            console.error('Error processing attachments:', error);
            await Promise.all((req.files || []).map(file => fsPromises.unlink(file.path).catch(() => { })));
            if (attachmentDir) {
                await fsPromises.rm(attachmentDir, { recursive: true, force: true }).catch(() => { });
            }
            res.status(500).json({ error: 'Failed to process attachments' });
        }
    });
});

// Image upload endpoint
app.post('/api/projects/:projectName/upload-images', authenticateToken, async (req, res) => {
    try {
        const multer = (await import('multer')).default;
        const path = (await import('path')).default;
        const fs = (await import('fs')).promises;
        const os = (await import('os')).default;

        // Configure multer for image uploads
        const storage = multer.diskStorage({
            destination: async (req, file, cb) => {
                const uploadDir = path.join(os.tmpdir(), 'pilotdeck-image-uploads', String(req.user.id));
                await fs.mkdir(uploadDir, { recursive: true });
                cb(null, uploadDir);
            },
            filename: (req, file, cb) => {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
                cb(null, uniqueSuffix + '-' + sanitizedName);
            }
        });

        const fileFilter = (req, file, cb) => {
            const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
            if (allowedMimes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
            }
        };

        const upload = multer({
            storage,
            fileFilter,
            limits: {
                fileSize: 5 * 1024 * 1024, // 5MB
                files: 5
            }
        });

        // Handle multipart form data
        upload.array('images', 5)(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ error: err.message });
            }

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No image files provided' });
            }

            try {
                // Process uploaded images
                const processedImages = await Promise.all(
                    req.files.map(async (file) => {
                        // Read file and convert to base64
                        const buffer = await fs.readFile(file.path);
                        const base64 = buffer.toString('base64');
                        const mimeType = file.mimetype;

                        // Clean up temp file immediately
                        await fs.unlink(file.path);

                        return {
                            name: file.originalname,
                            data: `data:${mimeType};base64,${base64}`,
                            size: file.size,
                            mimeType: mimeType
                        };
                    })
                );

                res.json({ images: processedImages });
            } catch (error) {
                console.error('Error processing images:', error);
                // Clean up any remaining files
                await Promise.all(req.files.map(f => fs.unlink(f.path).catch(() => { })));
                res.status(500).json({ error: 'Failed to process images' });
            }
        });
    } catch (error) {
        console.error('Error in image upload endpoint:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get token usage for a specific session
app.get('/api/projects/:projectName/sessions/:sessionId/token-usage', authenticateToken, async (req, res) => {
    try {
        const { projectName, sessionId } = req.params;
        const { provider = 'pilotdeck' } = req.query;
        const homeDir = os.homedir();

        // PilotDeck sessions use `web:s_<uuid>` keys; Windows-safe sessions
        // may use `web-s_<uuid>` because ':' is illegal in Windows filenames.
        if (provider === 'pilotdeck' || /^web[:_-]s_/.test(sessionId)) {
            return res.json(getSessionTokenBudget(sessionId));
        }

        // Allow only safe characters in sessionId
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }

        // Handle Cursor sessions - they use SQLite and don't have token usage info
        if (provider === 'cursor') {
            return res.json({
                used: 0,
                total: 0,
                breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
                unsupported: true,
                message: 'Token usage tracking not available for Cursor sessions'
            });
        }

        // Handle Gemini sessions - they are raw logs in our current setup
        if (provider === 'gemini') {
            return res.json({
                used: 0,
                total: 0,
                breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
                unsupported: true,
                message: 'Token usage tracking not available for Gemini sessions'
            });
        }

        // Handle Codex sessions
        if (provider === 'codex') {
            const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');

            // Find the session file by searching for the session ID
            const findSessionFile = async (dir) => {
                try {
                    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            const found = await findSessionFile(fullPath);
                            if (found) return found;
                        } else if (entry.name.includes(safeSessionId) && entry.name.endsWith('.jsonl')) {
                            return fullPath;
                        }
                    }
                } catch (error) {
                    // Skip directories we can't read
                }
                return null;
            };

            const sessionFilePath = await findSessionFile(codexSessionsDir);

            if (!sessionFilePath) {
                return res.status(404).json({ error: 'Codex session file not found', sessionId: safeSessionId });
            }

            // Read and parse the Codex JSONL file
            let fileContent;
            try {
                fileContent = await fsPromises.readFile(sessionFilePath, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Session file not found', path: sessionFilePath });
                }
                throw error;
            }
            const lines = fileContent.trim().split('\n');
            let totalTokens = 0;
            let contextWindow = 200000; // Default for Codex/OpenAI

            // Find the latest token_count event with info (scan from end)
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(lines[i]);

                    // Codex stores token info in event_msg with type: "token_count"
                    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
                        const tokenInfo = entry.payload.info;
                        if (tokenInfo.total_token_usage) {
                            totalTokens = tokenInfo.total_token_usage.total_tokens || 0;
                        }
                        if (tokenInfo.model_context_window) {
                            contextWindow = tokenInfo.model_context_window;
                        }
                        break; // Stop after finding the latest token count
                    }
                } catch (parseError) {
                    // Skip lines that can't be parsed
                    continue;
                }
            }

            return res.json({
                used: totalTokens,
                total: contextWindow
            });
        }

        // Extract actual project path
        let projectPath;
        try {
            projectPath = await extractProjectDirectory(projectName);
        } catch (error) {
            console.error('Error extracting project directory:', error);
            return res.status(500).json({ error: 'Failed to determine project path' });
        }


        const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDir = path.join(homeDir, '.pilotdeck', 'projects', encodedPath);

        const jsonlPath = path.join(projectDir, `${safeSessionId}.jsonl`);

        // Constrain to projectDir
        const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return res.status(400).json({ error: 'Invalid path' });
        }

        // Read and parse the JSONL file
        let fileContent;
        try {
            fileContent = await fsPromises.readFile(jsonlPath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Session file not found', path: jsonlPath });
            }
            throw error; // Re-throw other errors to be caught by outer try-catch
        }
        const lines = fileContent.trim().split('\n');

        const parsedContextWindow = parseInt(process.env.CONTEXT_WINDOW, 10);
        const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160000;
        let inputTokens = 0;
        let cacheCreationTokens = 0;
        let cacheReadTokens = 0;

        // Find the latest assistant message with usage data (scan from end)
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);

                // Only count assistant messages which have usage data
                if (entry.type === 'assistant' && entry.message?.usage) {
                    const usage = entry.message.usage;

                    // Use token counts from latest assistant message only
                    inputTokens = usage.input_tokens || 0;
                    cacheCreationTokens = usage.cache_creation_input_tokens || 0;
                    cacheReadTokens = usage.cache_read_input_tokens || 0;

                    break; // Stop after finding the latest assistant message
                }
            } catch (parseError) {
                // Skip lines that can't be parsed
                continue;
            }
        }

        // Calculate total context usage (excluding output_tokens, as per ccusage)
        const totalUsed = inputTokens + cacheCreationTokens + cacheReadTokens;

        res.json({
            used: totalUsed,
            total: contextWindow,
            breakdown: {
                input: inputTokens,
                cacheCreation: cacheCreationTokens,
                cacheRead: cacheReadTokens
            }
        });
    } catch (error) {
        console.error('Error reading session token usage:', error);
        res.status(500).json({ error: 'Failed to read session token usage' });
    }
});

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for actual static asset extensions only
    const ext = path.extname(req.path);
    if (ext && /^\.(js|css|map|json|ico|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|eot|mp4|webm)$/.test(ext)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(__dirname, '../dist/index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// Helper function to convert permissions to rwx format
function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true) {
    // Using fsPromises from import
    const items = [];

    try {
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            // Debug: log all entries including hidden files


            // Skip heavy build directories and VCS directories
            if (entry.name === 'node_modules' ||
                entry.name === 'dist' ||
                entry.name === 'build' ||
                entry.name === '.git' ||
                entry.name === '.svn' ||
                entry.name === '.hg') continue;

            const itemPath = path.join(dirPath, entry.name);
            const item = {
                name: entry.name,
                path: itemPath,
                type: entry.isDirectory() ? 'directory' : 'file'
            };

            // Get file stats for additional metadata
            try {
                const stats = await fsPromises.stat(itemPath);
                item.size = stats.size;
                item.modified = stats.mtime.toISOString();

                // Convert permissions to rwx format
                const mode = stats.mode;
                const ownerPerm = (mode >> 6) & 7;
                const groupPerm = (mode >> 3) & 7;
                const otherPerm = mode & 7;
                item.permissions = ((mode >> 6) & 7).toString() + ((mode >> 3) & 7).toString() + (mode & 7).toString();
                item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
            } catch (statError) {
                // If stat fails, provide default values
                item.size = 0;
                item.modified = null;
                item.permissions = '000';
                item.permissionsRwx = '---------';
            }

            if (entry.isDirectory() && currentDepth < maxDepth) {
                // Recursively get subdirectories but limit depth
                try {
                    // Check if we can access the directory before trying to read it
                    await fsPromises.access(item.path, fs.constants.R_OK);
                    item.children = await getFileTree(item.path, maxDepth, currentDepth + 1, showHidden);
                } catch (e) {
                    // Silently skip directories we can't access (permission denied, etc.)
                    item.children = [];
                }
            }

            items.push(item);
        }
    } catch (error) {
        // Only log non-permission errors to avoid spam
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            console.error('Error reading directory:', error);
        }
    }

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

const SERVER_PORT = process.env.SERVER_PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;

const PORT_FALLBACK_ATTEMPTS = 5;

// Pick a random high port in the 20000–59999 range. Random (rather than the
// preferred port + 1) because adjacent ports are frequently held by the same
// multi-port app that already took the preferred one.
function pickRandomHighPort() {
    return 20000 + Math.floor(Math.random() * 40000);
}

// Listen on `preferredPort`; on EADDRINUSE retry on random high ports up to
// PORT_FALLBACK_ATTEMPTS times. Resolves with the actually-bound port, or null
// if every attempt was in use. Non-EADDRINUSE errors reject — real failures
// (bad host, permissions) must not be silently retried.
function listenWithPortFallback(srv, preferredPort, host) {
    let port = preferredPort;
    let attempt = 0;
    return new Promise((resolve, reject) => {
        const tryListen = () => {
            attempt += 1;
            const onError = (err) => {
                srv.removeListener('listening', onListening);
                if (err && err.code === 'EADDRINUSE') {
                    if (attempt >= PORT_FALLBACK_ATTEMPTS) {
                        resolve(null);
                        return;
                    }
                    const nextPort = pickRandomHighPort();
                    console.log(`${c.warn('[WARN]')} Port ${port} is in use; retrying on random port ${nextPort} (attempt ${attempt}/${PORT_FALLBACK_ATTEMPTS})...`);
                    port = nextPort;
                    setImmediate(tryListen);
                    return;
                }
                reject(err);
            };
            const onListening = () => {
                srv.removeListener('error', onError);
                resolve(srv.address().port);
            };
            srv.once('error', onError);
            srv.once('listening', onListening);
            srv.listen(port, host);
        };
        tryListen();
    });
}

async function ensureLocalUserWhenAuthDisabled() {
    if (!DISABLE_LOCAL_AUTH || userDb.hasUsers()) {
        return;
    }
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    userDb.createUser('local', passwordHash);
    console.log(`${c.info('[INFO]')} Web UI login is disabled (default). Using built-in user. Set PILOTDECK_DISABLE_LOCAL_AUTH=0 to require username/password.`);
}

// Initialize database and start server
async function startServer() {
    try {
        await startServerAfterStartup({
            startupFn: async () => {
                await runServerStartupBeforeListen({
                    initializeDatabaseFn: initializeDatabase,
                    ensureLocalUserWhenAuthDisabledFn: ensureLocalUserWhenAuthDisabled,
                    configureWebPushFn: configureWebPush
                });
            },
            listenFn: async () => {
                // Check if running in production mode (dist folder exists)
                const distIndexPath = path.join(__dirname, '../dist/index.html');
                const isProduction = fs.existsSync(distIndexPath);

                console.log(`${c.info('[INFO]')} Chat execution routed through PilotDeck gateway (src/gateway).`);
                console.log('');

                if (isProduction) {
                    console.log(`${c.info('[INFO]')} Starting in production mode...`);
                } else {
                    console.log(`${c.info('[INFO]')} No production frontend build found; development mode expects Vite at http://${DISPLAY_HOST}:${VITE_PORT}`);
                }

                const boundPort = await listenWithPortFallback(server, Number(SERVER_PORT), HOST);
                if (boundPort === null) {
                    console.error(`${c.warn('[ERROR]')} Could not bind a port after ${PORT_FALLBACK_ATTEMPTS} attempts (preferred ${SERVER_PORT}). All tried ports were in use. Set SERVER_PORT to a free port and retry.`);
                    process.exit(1);
                }
                // Sync the actually-bound port back to the env so other modules
                // that self-reference SERVER_PORT (e.g. routes/taskmaster.js) hit
                // the right port after a fallback.
                process.env.SERVER_PORT = String(boundPort);
                {
                    const appInstallPath = path.join(__dirname, '..');

                    console.log('');
                    console.log(c.dim('═'.repeat(63)));
                    console.log(`  ${c.bright('PilotDeck Server - Ready')}`);
                    console.log(c.dim('═'.repeat(63)));
                    console.log('');
                    console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + boundPort)}`);
                    console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
                    console.log(`${c.tip('[TIP]')}  Run "pilotdeck status" for full configuration details`);
                    console.log('');

                    // Desktop shell loads the UI inside Electron; CLI/dev can opt in to
                    // auto-open. PILOTDECK_DESKTOP=1 is set by apps/desktop server-manager.
                    const skipAutoOpen =
                        process.env.PILOTDECK_DESKTOP === '1'
                        || process.env.PILOTDECK_SKIP_BROWSER_OPEN === '1';
                    if (!skipAutoOpen) {
                        const serverUrl = `http://${DISPLAY_HOST === '0.0.0.0' ? 'localhost' : DISPLAY_HOST}:${boundPort}`;
                        const openCmd = process.platform === 'darwin' ? 'open'
                                      : process.platform === 'win32' ? 'start'
                                      : 'xdg-open';
                        exec(`${openCmd} "${serverUrl}"`, () => {});
                    }

                    // Start watching the projects folder for changes
                    await setupProjectsWatcher();

                    // Start background memory scheduler for auto index/dream.
                    startMemoryScheduler();

                    // Start server-side plugin processes for enabled plugins
                    startEnabledPluginServers().catch(err => {
                        console.error('[Plugins] Error during startup:', err.message);
                    });

                    // Hot-reload watcher: external edits to ~/.pilotdeck/pilotdeck.yaml
                    // (vim, Cursor, another process) trigger a validate+reload and push
                    // a "config:reloaded" event to every connected WebSocket client.
                    await startPilotDeckConfigWatcher({
                        onEvent: (payload) => {
                            process.emit('pilotdeck:config-broadcast', payload);
                        },
                    });
                }
            }
        });

        let shutdownPromise = null;
        const gracefulShutdown = async () => {
            if (shutdownPromise) {
                return shutdownPromise;
            }

            shutdownPromise = (async () => {
                try {
                    stopMemoryScheduler();
                    closeMemoryServices();
                    stopPilotDeckConfigWatcher();
                    await stopAllPlugins();
                    // helpers were retired with the four-provider runtime.
                    try {
                        const { shutdownGlobalChrome, stopChromeHealthCheck } = await import('./utils/globalChrome.js');
                        stopChromeHealthCheck();
                        shutdownGlobalChrome();
                    } catch { /* Chrome may not have been started */ }
                    // PilotDeck cron is owned by `pilotdeck server` and shuts
                    // down with it; ui/server never spawns its own daemon.
                } finally {
                    process.exit(0);
                }
            })();

            return shutdownPromise;
        };
        process.on('SIGTERM', () => void gracefulShutdown());
        process.on('SIGINT', () => void gracefulShutdown());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
