function isLoopbackHost(hostname) {
    return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export async function createOpenMaicCoursewareLaunchUrl({
    baseUrl,
    query = {},
    handoffToken = '',
    fetchImpl = globalThis.fetch,
    nodeEnv = process.env.NODE_ENV,
}) {
    const destination = new URL(baseUrl);
    if (!['http:', 'https:'].includes(destination.protocol)) {
        throw new Error('课程生成入口地址必须使用 http 或 https');
    }
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && String(value)) {
            destination.searchParams.set(key, String(value));
        }
    }

    const token = String(handoffToken || '').trim();
    if (!token) {
        if (nodeEnv === 'production' || !isLoopbackHost(destination.hostname)) {
            throw new Error('OpenMAIC 课程交接令牌未配置');
        }
        return destination.toString();
    }

    const sessionEndpoint = new URL('/api/tiku/courseware/session', destination.origin);
    const response = await fetchImpl(sessionEndpoint, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-tongcheng-handoff-token': token,
        },
        body: JSON.stringify({
            redirectTo: `${destination.pathname}${destination.search}${destination.hash}`,
        }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.launchUrl) {
        throw new Error(payload?.error || `OpenMAIC 课程交接会话创建失败：HTTP ${response.status}`);
    }

    const launchUrl = new URL(payload.launchUrl, destination.origin);
    if (launchUrl.origin !== destination.origin) {
        throw new Error('OpenMAIC 返回了不受信任的课程交接地址');
    }
    return launchUrl.toString();
}
