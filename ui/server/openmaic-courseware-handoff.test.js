import { describe, expect, it, vi } from 'vitest';
import { createOpenMaicCoursewareLaunchUrl } from './openmaic-courseware-handoff.js';

describe('OpenMAIC courseware handoff', () => {
    it('exchanges the service token server-side and only returns a short-lived launch URL', async () => {
        const fetchImpl = vi.fn(async (_url, options) => {
            expect(options.headers['x-tongcheng-handoff-token']).toBe('secret-token');
            const body = JSON.parse(options.body);
            expect(body.redirectTo).toContain('/courseware-pilot?');
            expect(body.redirectTo).not.toContain('secret-token');
            return new Response(JSON.stringify({
                success: true,
                launchUrl: '/api/tiku/courseware/session?ticket=short-ticket',
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        const result = await createOpenMaicCoursewareLaunchUrl({
            baseUrl: 'https://openmaic.example/courseware-pilot',
            query: { assetWorkspace: '/tmp/fixture', subject: 'cpp' },
            handoffToken: 'secret-token',
            fetchImpl,
            nodeEnv: 'production',
        });

        expect(result).toBe('https://openmaic.example/api/tiku/courseware/session?ticket=short-ticket');
        expect(result).not.toContain('secret-token');
    });

    it('allows a tokenless direct URL only for local development', async () => {
        const local = await createOpenMaicCoursewareLaunchUrl({
            baseUrl: 'http://localhost:3000/courseware-pilot',
            query: { subject: 'math' },
            nodeEnv: 'development',
        });
        expect(local).toBe('http://localhost:3000/courseware-pilot?subject=math');

        await expect(createOpenMaicCoursewareLaunchUrl({
            baseUrl: 'https://openmaic.example/courseware-pilot',
            nodeEnv: 'production',
        })).rejects.toThrow('交接令牌未配置');
    });

    it('rejects a launch URL that escapes the configured OpenMAIC origin', async () => {
        await expect(createOpenMaicCoursewareLaunchUrl({
            baseUrl: 'https://openmaic.example/courseware-pilot',
            handoffToken: 'secret-token',
            nodeEnv: 'production',
            fetchImpl: async () => new Response(JSON.stringify({
                launchUrl: 'https://attacker.example/session',
            }), { status: 200, headers: { 'content-type': 'application/json' } }),
        })).rejects.toThrow('不受信任');
    });
});
