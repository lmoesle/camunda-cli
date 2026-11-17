import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import {
    AxiosUserTaskAdapter, CompleteUserTaskUseCase, ConsoleUserTasksPresenter, createCamundaCli,
    ListUserTasksUseCase, Profile,
} from '../src';

// Documentation-shaped dummy endpoints only. Every request is intercepted below;
// these tests never read stored profiles or contact a cluster.
const clusterId = '00000000-0000-4000-8000-000000000000';
const gateway = `https://fra-1.zeebe.camunda.io/${clusterId}`;
const tasklist = `https://fra-1.tasklist.camunda.io/${clusterId}`;
const tokenUrl = 'https://login.cloud.camunda.io/oauth/token';
const large = '9223372036854775807';
const profile: Profile = {
    name: 'saas',
    baseUrl: gateway,
    oAuthUrl: tokenUrl,
    clientId: 'dummy-client',
    clientSecret: 'dummy-secret',
    audience: 'zeebe.camunda.io',
    operateAudience: 'operate.camunda.io',
};
const firstCursor = ['2026-01-01T00:00:00.000Z', large, 'first-tiebreaker'];
const secondCursor = ['2026-01-02T00:00:00.000Z', '1', 'second-tiebreaker'];

function nativeTask(id: string, creationDate: string, assignee: string | null, sortValues: string[]) {
    return {
        id, taskDefinitionId: 'review', taskState: 'CREATED', processInstanceKey: large,
        creationDate, assignee, implementation: 'ZEEBE_USER_TASK', sortValues,
    };
}

function saasTransport() {
    let page = 0;
    const request = jest.fn(async (config: AxiosRequestConfig) => {
        if (config.method !== 'POST') throw new Error('Unexpected mock HTTP method; network access is forbidden.');
        if (config.url === tokenUrl) {
            const audience = new URLSearchParams(config.data as string).get('audience');
            if (audience === 'tasklist.camunda.io') return { status: 200, data: '{"access_token":"dummy.tasklist"}' };
            if (audience === 'zeebe.camunda.io') return { status: 200, data: '{"access_token":"dummy.gateway"}' };
            throw new Error('Unexpected mock OAuth audience.');
        }
        if (config.url === `${gateway}/v2/user-tasks/search`) {
            // Camunda 8.7 SaaS does not enable the alpha gateway Query API by default.
            throw Object.assign(new Error('Method Not Allowed'), { isAxiosError: true, response: { status: 405 } });
        }
        const headers = config.headers as Record<string, string>;
        if (config.url === `${tasklist}/v1/tasks/search`) {
            if (headers.Authorization !== 'Bearer dummy.tasklist') {
                throw Object.assign(new Error('Wrong service token'), { isAxiosError: true, response: { status: 401 } });
            }
            const pages = [
                [nativeTask(large, firstCursor[0], null, firstCursor)],
                [nativeTask('1', secondCursor[0], 'dummy-assignee', secondCursor)],
                [],
            ];
            if (page >= pages.length) throw new Error('Unexpected extra search request.');
            return { status: 200, data: JSON.stringify(pages[page++]) };
        }
        if (config.url === `${gateway}/v2/user-tasks/${large}/completion`) {
            if (headers.Authorization !== 'Bearer dummy.gateway') {
                throw Object.assign(new Error('Wrong service token'), { isAxiosError: true, response: { status: 401 } });
            }
            return { status: 204, data: '' };
        }
        throw new Error('Unexpected mock URL; network access is forbidden.');
    });
    return { request, adapter: new AxiosUserTaskAdapter({ request } as unknown as AxiosInstance) };
}

function mockSaasPages(pages: unknown[]) {
    let index = 0;
    const request = jest.fn(async (config: AxiosRequestConfig) => {
        if (config.url === tokenUrl) return { status: 200, data: '{"access_token":"dummy.tasklist"}' };
        if (config.url !== `${tasklist}/v1/tasks/search` || index >= pages.length) throw new Error('Unexpected mock request.');
        const value = pages[index++];
        if (value instanceof Error) throw value;
        return { status: 200, data: JSON.stringify(value) };
    });
    const adapter = new AxiosUserTaskAdapter({ request } as unknown as AxiosInstance);
    const writeLine = jest.fn();
    const usecase = new ListUserTasksUseCase({ getProfile: () => profile }, adapter, new ConsoleUserTasksPresenter(writeLine));
    return { request, adapter, writeLine, usecase };
}

describe('Camunda 8.7 standard SaaS user task routing regression', () => {
    test.each([false, true])('unchanged CLI lists native CREATED tasks through stable Tasklist, filtered=%s', async (filtered) => {
        const { request, adapter } = saasTransport();
        const getProfile = jest.fn((name: string) => name === 'saas' ? profile : undefined);
        const writeLine = jest.fn();
        const usecase = new ListUserTasksUseCase({ getProfile }, adapter, new ConsoleUserTasksPresenter(writeLine));
        const cli = createCamundaCli({ listUserTasksInPort: usecase });
        const args = ['usertasks', 'get', '--profile', 'saas',
            ...(filtered ? ['--filter', 'process-instance', large] : []), '--json'];

        // Before the fix this rejected with HTTP 405 from the gateway alpha search.
        await expect(cli.parseAsync(args, { from: 'user' })).resolves.toBe(cli);

        expect(getProfile).toHaveBeenCalledWith('saas');
        expect(request.mock.calls.map(([config]) => config.url)).toEqual([
            tokenUrl, `${tasklist}/v1/tasks/search`, `${tasklist}/v1/tasks/search`, `${tasklist}/v1/tasks/search`,
        ]);
        const auth = request.mock.calls[0][0];
        expect(Object.fromEntries(new URLSearchParams(auth.data as string))).toEqual({
            grant_type: 'client_credentials', client_id: profile.clientId, client_secret: profile.clientSecret,
            audience: 'tasklist.camunda.io',
        });
        expect(auth.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
        const baseBody = {
            state: 'CREATED', implementation: 'ZEEBE_USER_TASK',
            ...(filtered ? { processInstanceKey: large } : {}),
            pageSize: 100, sort: [{ field: 'creationTime', order: 'ASC' }],
        };
        for (const [index, cursor] of [undefined, firstCursor, secondCursor].entries()) {
            const config = request.mock.calls[index + 1][0];
            expect(config.headers).toMatchObject({ 'Content-Type': 'application/json', Authorization: 'Bearer dummy.tasklist' });
            expect(JSON.parse(config.data as string)).toEqual({
                ...baseBody, ...(cursor === undefined ? {} : { searchAfter: cursor }),
            });
        }
        for (const [config] of request.mock.calls) expect(config).toMatchObject({ timeout: 30000, maxRedirects: 0 });
        expect(writeLine).toHaveBeenCalledTimes(1);
        expect(JSON.parse(writeLine.mock.calls[0][0])).toEqual([
            expect.objectContaining({ key: large, processInstanceKey: large, elementId: 'review',
                state: 'CREATED', creationDate: firstCursor[0], assignee: null }),
            expect.objectContaining({ key: '1', processInstanceKey: large, elementId: 'review',
                state: 'CREATED', creationDate: secondCursor[0], assignee: 'dummy-assignee' }),
        ]);
    });

    test('SaaS completion stays on gateway with gateway audience and a single 204 mutation', async () => {
        const { request, adapter } = saasTransport();
        const writeLine = jest.fn();
        const usecase = new CompleteUserTaskUseCase({ getProfile: () => profile }, adapter, new ConsoleUserTasksPresenter(writeLine));
        await createCamundaCli({ completeUserTaskInPort: usecase }).parseAsync([
            'usertask', large, 'complete', '--profile', 'saas', '--variablen', '{}',
        ], { from: 'user' });

        expect(request.mock.calls.map(([config]) => config.url)).toEqual([
            tokenUrl, `${gateway}/v2/user-tasks/${large}/completion`,
        ]);
        expect(new URLSearchParams(request.mock.calls[0][0].data as string).get('audience')).toBe('zeebe.camunda.io');
        expect(request.mock.calls[1][0]).toMatchObject({
            method: 'POST', headers: { Authorization: 'Bearer dummy.gateway', 'Content-Type': 'application/json' },
            data: '{"variables":{}}', timeout: 30000, maxRedirects: 0,
        });
        expect(writeLine.mock.calls).toEqual([[`Completed user task ${large}.`]]);
    });

    test('reused SaaS session isolates read and completion tokens without mutating its connection', async () => {
        const { request, adapter } = saasTransport();
        const connection = Object.freeze({ restUrl: `${gateway}/v2`, oauth: Object.freeze({
            oAuthUrl: tokenUrl, clientId: 'dummy-client', clientSecret: 'dummy-secret', audience: 'zeebe.camunda.io',
        }) });
        const session = await adapter.connect(connection);
        await session.complete(large, {});
        await session.search();
        await session.complete(large, {});
        expect(request.mock.calls.map(([config]) => config.url)).toEqual([
            tokenUrl, `${gateway}/v2/user-tasks/${large}/completion`,
            tokenUrl, `${tasklist}/v1/tasks/search`, `${tasklist}/v1/tasks/search`, `${tasklist}/v1/tasks/search`,
            tokenUrl, `${gateway}/v2/user-tasks/${large}/completion`,
        ]);
        expect(request.mock.calls.filter(([config]) => config.url === tokenUrl).map(([config]) =>
            new URLSearchParams(config.data as string).get('audience'))).toEqual([
            'zeebe.camunda.io', 'tasklist.camunda.io', 'zeebe.camunda.io',
        ]);
        expect(connection.oauth.audience).toBe('zeebe.camunda.io');
        expect(connection.restUrl).toBe(`${gateway}/v2`);
    });

    test.each([gateway, `${gateway}/`, `${gateway}/v2///`, gateway.replace('.io/', '.io:443/')])(
        'recognizes canonical SaaS baseUrl %s independently of profile name', async (baseUrl) => {
            const s = mockSaasPages([[]]);
            await new ListUserTasksUseCase({ getProfile: () => ({ ...profile, name: 'not-saas', baseUrl }) },
                s.adapter, new ConsoleUserTasksPresenter(s.writeLine)).listUserTasks({ profile: 'not-saas', json: true });
            expect(s.request.mock.calls.map(([config]) => config.url)).toEqual([tokenUrl, `${tasklist}/v1/tasks/search`]);
            expect(s.writeLine.mock.calls).toEqual([['[]']]);
        });

    test.each([
        gateway.replace('https:', 'http:'),
        gateway.replace('.io/', '.io:8443/'),
        gateway.replace('fra-1.zeebe.camunda.io', 'fra-1.zeebe.camunda.io.evil.example'),
        gateway.replace('fra-1.zeebe.camunda.io', 'fra-1.evil.zeebe.camunda.io'),
        gateway.replace('fra-1.zeebe.camunda.io', 'fra-1-zeebe.camunda.io'),
        gateway.replace('fra-1.zeebe.camunda.io', 'fra.zeebe.camunda.io'),
        gateway.replace('fra-1.zeebe.camunda.io', 'gateway.example'),
        `${gateway}/proxy/v2`,
        gateway.replace(`/${clusterId}`, `/proxy/${clusterId}`),
        gateway.replace(clusterId, 'not-a-cluster-id'),
        'https://fra-1.zeebe.camunda.io',
    ])('does not infer SaaS from profile name or issuer for %s', async (baseUrl) => {
        const request = jest.fn(async (config: AxiosRequestConfig) => config.url === tokenUrl
            ? { status: 200, data: '{"access_token":"dummy.gateway"}' }
            : { status: 200, data: '{"items":[],"page":{}}' });
        const adapter = new AxiosUserTaskAdapter({ request } as unknown as AxiosInstance);
        const writeLine = jest.fn();
        await new ListUserTasksUseCase({ getProfile: () => ({ ...profile, baseUrl }) }, adapter,
            new ConsoleUserTasksPresenter(writeLine)).listUserTasks({ profile: 'saas', json: true });
        const root = new URL(baseUrl).toString().replace(/\/+$/, '');
        expect(request.mock.calls.map(([config]) => config.url)).toEqual([
            tokenUrl, `${root}${root.endsWith('/v2') ? '' : '/v2'}/user-tasks/search`,
        ]);
        expect(new URLSearchParams(request.mock.calls[0][0].data as string).get('audience')).toBe('zeebe.camunda.io');
    });

    test.each([true, false])('empty Tasklist output, json=%s', async (json) => {
        const s = mockSaasPages([[]]);
        await s.usecase.listUserTasks({ profile: 'saas', json });
        expect(s.writeLine).toHaveBeenCalledTimes(1);
        expect(s.writeLine.mock.calls[0][0]).toEqual(json ? '[]'
            : expect.stringContaining('USER TASK KEY'));
        expect(s.request).toHaveBeenCalledTimes(2);
    });

    test('Tasklist aliases feed the existing table with terminal escaping', async () => {
        const s = mockSaasPages([[{ ...nativeTask(large, firstCursor[0], null, firstCursor), taskDefinitionId: 'review\u001b[31m' }], []]);
        await s.usecase.listUserTasks({ profile: 'saas' });
        expect(s.writeLine).toHaveBeenCalledTimes(1);
        expect(s.writeLine.mock.calls[0][0]).toContain('review\\u001b[31m');
        expect(s.writeLine.mock.calls[0][0]).toContain(large);
    });

    test.each([
        null, {}, { items: [], page: {} }, [null], [{}],
        [{ ...nativeTask(large, firstCursor[0], null, firstCursor), implementation: 'JOB_WORKER' }],
        [{ ...nativeTask(large, firstCursor[0], null, firstCursor), taskState: 'COMPLETED' }],
        [{ ...nativeTask(large, firstCursor[0], null, firstCursor), id: 123 }],
        [{ ...nativeTask(large, firstCursor[0], null, firstCursor), taskDefinitionId: null }],
        [{ ...nativeTask(large, firstCursor[0], null, firstCursor), processInstanceKey: '0' }],
    ].map((value) => [value]))('rejects malformed or non-native Tasklist page %j without output', async (value) => {
        const s = mockSaasPages([value]);
        await expect(s.usecase.listUserTasks({ profile: 'saas', json: true })).rejects.toThrow(/malformed|non-native/);
        expect(s.writeLine).not.toHaveBeenCalled();
        expect(s.request).toHaveBeenCalledTimes(2);
    });

    test.each([undefined, null, [], [1], ['date', 1], 'cursor', [{}]].map((value) => [value]))(
        'rejects Tasklist cursor %j without output', async (sortValues) => {
            const s = mockSaasPages([[{ ...nativeTask(large, firstCursor[0], null, firstCursor), sortValues }]]);
            await expect(s.usecase.listUserTasks({ profile: 'saas', json: true })).rejects.toThrow('cursor');
            expect(s.writeLine).not.toHaveBeenCalled();
            expect(s.request).toHaveBeenCalledTimes(2);
        });

    test.each(['repeat', 'cycle', 'duplicate', 'date order', 'mismatch', 'later failure'])(
        'rejects Tasklist %s across short pages without partial stdout', async (scenario) => {
            const second = nativeTask('1', secondCursor[0], 'dummy-assignee', secondCursor);
            const pages: unknown[] = [[nativeTask(large, firstCursor[0], null, firstCursor)]];
            if (scenario === 'repeat') pages.push([{ ...second, sortValues: firstCursor }]);
            if (scenario === 'cycle') pages.push([second], [nativeTask('2', secondCursor[0], null, firstCursor)]);
            if (scenario === 'duplicate') pages.push([{ ...second, id: large }]);
            if (scenario === 'date order') pages.push([{ ...second, creationDate: '2025-01-01T00:00:00Z' }]);
            if (scenario === 'mismatch') pages.push([{ ...second, processInstanceKey: '2' }]);
            if (scenario === 'later failure') pages.push(new Error('secret-body'));
            const s = mockSaasPages(pages);
            const result = s.usecase.listUserTasks({ profile: 'saas', json: true, processInstance: large });
            await expect(result).rejects.toThrow();
            await expect(result).rejects.not.toThrow('secret-body');
            expect(s.writeLine).not.toHaveBeenCalled();
            expect(s.request).toHaveBeenCalledTimes(scenario === 'cycle' ? 4 : 3);
        });

    test.each([401, 403])('sanitizes Tasklist HTTP %s with permission guidance, no retries or fallback', async (status) => {
        const error = Object.assign(new Error('secret-token-body'), { isAxiosError: true, response: { status } });
        const s = mockSaasPages([error]);
        const result = s.usecase.listUserTasks({ profile: 'saas', json: true });
        await expect(result).rejects.toThrow(`HTTP ${status}`);
        await expect(result).rejects.toThrow('Tasklist client permissions');
        await expect(result).rejects.not.toThrow('secret-token-body');
        await expect(result).rejects.not.toHaveProperty('cause');
        expect(s.writeLine).not.toHaveBeenCalled();
        expect(s.request).toHaveBeenCalledTimes(2);
    });

    test.each(['{}', 'null', '{"access_token":"bad\\r\\ntoken"}'])('bad Tasklist OAuth token %s prevents searches', async (data) => {
        const s = mockSaasPages([]);
        s.request.mockResolvedValue({ status: 200, data });
        await expect(s.usecase.listUserTasks({ profile: 'saas' })).rejects.toThrow('Tasklist OAuth authentication');
        expect(s.request).toHaveBeenCalledTimes(1);
        expect(s.writeLine).not.toHaveBeenCalled();
    });

    test.each([401, 403])('Tasklist OAuth HTTP %s stops before query without leaking causes', async (status) => {
        const s = mockSaasPages([]);
        s.request.mockRejectedValue(Object.assign(new Error('dummy-secret-token'), { isAxiosError: true,
            response: { status, data: 'secret-body' } }));
        const result = s.usecase.listUserTasks({ profile: 'saas', json: true });
        await expect(result).rejects.toThrow(`Tasklist OAuth authentication failed (HTTP ${status})`);
        await expect(result).rejects.toThrow('Tasklist client permissions');
        await expect(result).rejects.not.toThrow(/dummy-secret-token|secret-body/);
        await expect(result).rejects.not.toHaveProperty('cause');
        expect(s.request).toHaveBeenCalledTimes(1);
        expect(s.writeLine).not.toHaveBeenCalled();
    });

    test('explicit noAuth strips polluted defaults for both Tasklist and gateway without OAuth', async () => {
        const calls: { url?: string; authorization?: string; cookie?: string; proxy?: string; auth?: unknown; credentials?: boolean }[] = [];
        const http = axios.create({
            auth: { username: 'dummy', password: 'dummy-secret' }, withCredentials: true,
            headers: { Authorization: 'Bearer inherited', Cookie: 'dummy=cookie', 'Proxy-Authorization': 'Basic inherited' },
            adapter: async (config) => {
                calls.push({ url: config.url, authorization: config.headers.get('Authorization') as string | undefined,
                    cookie: config.headers.get('Cookie') as string | undefined, proxy: config.headers.get('Proxy-Authorization') as string | undefined,
                    auth: config.auth, credentials: config.withCredentials });
                if (config.url === `${tasklist}/v1/tasks/search`) return { status: 200, statusText: 'OK', headers: {}, config, data: '[]' };
                if (config.url === `${gateway}/v2/user-tasks/${large}/completion`) return { status: 204, statusText: 'No Content', headers: {}, config, data: '' };
                throw new Error('Unexpected mock URL; network access forbidden.');
            },
        });
        const session = await new AxiosUserTaskAdapter(http).connect({ restUrl: `${gateway}/v2`, noAuth: true,
            oauth: { oAuthUrl: tokenUrl, clientId: 'dummy-client', clientSecret: 'dummy-secret', audience: 'zeebe.camunda.io' } });
        expect(await session.search()).toEqual([]);
        await session.complete(large, {});
        expect(calls).toEqual([
            { url: `${tasklist}/v1/tasks/search`, authorization: undefined, cookie: undefined, proxy: undefined, auth: undefined, credentials: false },
            { url: `${gateway}/v2/user-tasks/${large}/completion`, authorization: undefined, cookie: undefined, proxy: undefined, auth: undefined, credentials: false },
        ]);
        expect(http.defaults.auth).toEqual({ username: 'dummy', password: 'dummy-secret' });
        expect(http.defaults.headers.Cookie).toBe('dummy=cookie');
        expect(http.defaults.withCredentials).toBe(true);
    });
});
