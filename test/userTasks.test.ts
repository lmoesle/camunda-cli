import axios, { AxiosInstance } from 'axios';
import { Command } from 'commander';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
    AxiosUserTaskAdapter, CompleteUserTaskUseCase, ConsoleUserTasksPresenter, createCamundaCli,
    createDefaultCamundaCli, JsonProfileRepositoryAdapter, ListUserTasksUseCase, Profile,
    runDefaultCamundaCli, UserTask, userTaskKey,
} from '../src';
import { parseVariables } from '../src/domain/variables';

const large = '9223372036854775807';
const profile: Profile = { name: 'on-prem', baseUrl: 'http://localhost:8080/proxy/v2///' };
const oauth = { oAuthUrl: 'https://auth.example/token', clientId: 'dummy+client', clientSecret: 'dummy&secret' };
const task = (key = large, assignee: string | null = null): UserTask => ({
    key, processInstanceKey: large, elementId: 'review', assignee, state: 'CREATED', creationDate: '2026-01-01T00:00:00Z',
});
const page = (items: unknown[], cursor: unknown[] = ['date', large]) =>
    ({ status: 200, data: JSON.stringify({ items, page: { totalItems: 1, lastSortValues: cursor } }) });

function state(selected: Profile | undefined = profile) {
    const getProfile = jest.fn((): Profile | undefined => selected);
    const search = jest.fn().mockResolvedValue([task()]);
    const complete = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockResolvedValue({ search, complete });
    const showUserTasks = jest.fn();
    const showCompleted = jest.fn();
    const ports = { getProfile, search, complete, connect, showUserTasks, showCompleted };
    return { ...ports, list: new ListUserTasksUseCase(ports, ports, ports),
        completion: new CompleteUserTaskUseCase(ports, ports, ports) };
}
const completion = { id: large, profile: ' on-prem ', variables: '{}' };

describe('user task validation and use cases', () => {
    test.each(['1', large, ' 0001 '])('normalizes exact signed-int64 key %s', (key) => {
        expect(userTaskKey(key)).toBe(BigInt(key).toString());
    });
    test.each(['', ' ', '0', '-1', '+1', '1.0', '1e2', '0x10', '9223372036854775808', 'bad'])(
        'rejects key %j before profile or network', async (key) => {
            const s = state();
            await expect(s.list.listUserTasks({ profile: 'on-prem', processInstance: key })).rejects.toThrow('signed-int64');
            await expect(s.completion.completeUserTask({ ...completion, id: key })).rejects.toThrow('signed-int64');
            expect(s.getProfile).not.toHaveBeenCalled();
            expect(s.connect).not.toHaveBeenCalled();
        });
    test.each(['', 'null', '[]', '42', 'true', '"text"', '{"secret":', "{'x':1}", 'vars.json', '@vars.json'])(
        'requires strict inline object %j before profile lookup', async (variables) => {
            const s = state();
            await expect(s.completion.completeUserTask({ ...completion, variables })).rejects.toThrow('inline JSON object');
            expect(s.getProfile).not.toHaveBeenCalled();
            expect(s.connect).not.toHaveBeenCalled();
        });
    test('lists unfiltered/filtered tasks after connecting once, presents only full result', async () => {
        const s = state();
        await s.list.listUserTasks({ profile: ' on-prem ' });
        expect(s.getProfile).toHaveBeenCalledWith('on-prem');
        expect(s.connect).toHaveBeenCalledWith({ restUrl: 'http://localhost:8080/proxy/v2' });
        expect(s.search).toHaveBeenCalledWith(undefined);
        expect(s.showUserTasks).toHaveBeenCalledWith([task()], false);
        await s.list.listUserTasks({ profile: 'on-prem', processInstance: ' 0001 ', json: true });
        expect(s.search).toHaveBeenLastCalledWith('1');
        expect(s.showUserTasks).toHaveBeenLastCalledWith([task()], true);
        s.showUserTasks.mockClear();
        s.search.mockRejectedValue(new Error('search failed'));
        await expect(s.list.listUserTasks({ profile: 'on-prem', json: true })).rejects.toThrow();
        expect(s.showUserTasks).not.toHaveBeenCalled();
    });
    test.each(['', ' '])('requires profile %j for both actions', async (name) => {
        const s = state();
        await expect(s.list.listUserTasks({ profile: name })).rejects.toThrow('profile');
        await expect(s.completion.completeUserTask({ ...completion, profile: name })).rejects.toThrow('profile');
        expect(s.connect).not.toHaveBeenCalled();
    });
    test('missing profile and invalid endpoint/auth configuration fail without network', async () => {
        for (const selected of [undefined, { ...profile, baseUrl: 'ftp://bad' }, { ...profile, clientId: 'partial' }]) {
            const s = state();
            s.getProfile.mockReturnValue(selected);
            await expect(s.list.listUserTasks({ profile: 'on-prem' })).rejects.toThrow(/profile|Profile/);
            await expect(s.completion.completeUserTask(completion)).rejects.toThrow(/profile|Profile/);
            expect(s.connect).not.toHaveBeenCalled();
        }
    });
    test('completion awaits acknowledgement and reports uncertain failure without exposing cause', async () => {
        const s = state();
        let finish!: () => void;
        s.complete.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
        const pending = s.completion.completeUserTask(completion);
        await Promise.resolve();
        expect(s.showCompleted).not.toHaveBeenCalled();
        finish();
        await pending;
        expect(s.complete).toHaveBeenCalledWith(large, {});
        expect(s.showCompleted).toHaveBeenCalledWith(large);
        s.showCompleted.mockClear();
        s.complete.mockRejectedValue(new Error('secret variables'));
        const result = s.completion.completeUserTask(completion);
        await expect(result).rejects.toThrow('outcome may be uncertain. Check cluster state before rerunning');
        await expect(result).rejects.not.toThrow('secret');
        await expect(result).rejects.not.toHaveProperty('cause');
        expect(s.showCompleted).not.toHaveBeenCalled();
    });
});

function mockHttp() {
    const request = jest.fn();
    return { request, adapter: new AxiosUserTaskAdapter({ request } as unknown as AxiosInstance) };
}

describe('user task HTTP wire contract', () => {
    test('paginates beyond short pages and capped totals with full lossless cursors; one OAuth per invocation', async () => {
        const { request, adapter } = mockHttp();
        for (const token of ['dummy.one', 'dummy.two']) {
            request.mockResolvedValueOnce({ status: 200, data: `{"access_token":"${token}"}` })
                .mockResolvedValueOnce({ status: 200, data: `{"items":[${JSON.stringify(task())}],"page":{"totalItems":1,"lastSortValues":["date",${large},1]}}` })
                .mockResolvedValueOnce(page([task('1', 'alice')], ['later', '1', 2]))
                .mockResolvedValueOnce(page([]));
            const session = await adapter.connect({ restUrl: 'https://gateway.example/proxy/v2', oauth });
            expect(await session.search(large)).toEqual([task(), task('1', 'alice')]);
        }
        expect(request).toHaveBeenCalledTimes(8);
        expect(Object.fromEntries(new URLSearchParams(request.mock.calls[0][0].data))).toEqual({
            grant_type: 'client_credentials', client_id: oauth.clientId, client_secret: oauth.clientSecret,
        });
        for (const offset of [0, 4]) {
            const configs = request.mock.calls.slice(offset + 1, offset + 4).map(([config]) => config);
            expect(configs[0]).toMatchObject({ method: 'POST', url: 'https://gateway.example/proxy/v2/user-tasks/search',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer dummy.${offset === 0 ? 'one' : 'two'}` } });
            expect(configs[0].data).toBe(`{"filter":{"state":"CREATED","processInstanceKey":"${large}"},"sort":[{"field":"creationDate","order":"ASC"}],"page":{"limit":100}}`);
            expect(configs[1].data).toContain(`"searchAfter":["date",${large},1]`);
            expect(configs[2].data).toContain('"searchAfter":["later","1",2]');
        }
        for (const [config] of request.mock.calls) expect(config).toMatchObject({ timeout: 30000, maxRedirects: 0, responseType: 'text' });
    });
    test('unfiltered search includes assigned and unassigned CREATED tasks without implicit assignment', async () => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValueOnce(page([task('1'), task('2', 'alice')])).mockResolvedValueOnce(page([]));
        const session = await adapter.connect({ restUrl: 'http://localhost/v2' });
        expect(await session.search()).toEqual([task('1'), task('2', 'alice')]);
        expect(JSON.parse(request.mock.calls[0][0].data).filter).toEqual({ state: 'CREATED' });
        expect(request.mock.calls.every(([config]) => config.url.endsWith('/search'))).toBe(true);
    });
    test('JSON output retains additional task fields and genuine large numbers without trusting marker objects', async () => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValueOnce({ status: 200,
            data: `{"items":[${JSON.stringify(task()).slice(0, -1)},"extra":${large},"marker":{"isLosslessNumber":true,"value":"1"}}],"page":{"lastSortValues":["date",${large}]}}` })
            .mockResolvedValueOnce(page([]));
        const tasks = await (await adapter.connect({ restUrl: 'http://localhost/v2' })).search();
        const write = jest.fn();
        new ConsoleUserTasksPresenter(write).showUserTasks(tasks, true);
        expect(write.mock.calls[0][0]).toContain(`"extra": ${large}`);
        expect(JSON.parse(write.mock.calls[0][0])[0].marker).toEqual({ isLosslessNumber: true, value: '1' });
    });
    test('completion sends one POST with precision and spoof-safe nested variables; accepts empty 204', async () => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValue({ status: 204, data: '' });
        const session = await adapter.connect({ restUrl: 'http://localhost/proxy/v2' });
        const variables = `{"nested":[${large},{"isLosslessNumber":true,"value":"1"}],"isLosslessNumber":true,"value":"text"}`;
        await session.complete(large, parseVariables(variables));
        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0][0]).toMatchObject({ method: 'POST', url: `http://localhost/proxy/v2/user-tasks/${large}/completion`,
            data: `{"variables":${variables}}`, timeout: 30000, maxRedirects: 0 });
    });
    test.each([200, 201, 202])('rejects unexpected completion status %s', async (status) => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValue({ status, data: '' });
        await expect((await adapter.connect({ restUrl: 'http://localhost/v2' })).complete('1', {})).rejects.toThrow('unexpected HTTP status');
        expect(request).toHaveBeenCalledTimes(1);
    });
    test('rejects nonempty 204 acknowledgement', async () => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValue({ status: 204, data: '{"secret":"body"}' });
        await expect((await adapter.connect({ restUrl: 'http://localhost/v2' })).complete('1', {})).rejects.toThrow('malformed acknowledgement');
    });
    test.each([undefined, 401, 403, 404, 409, 307, 500])('sanitizes search and completion failure %j without retry', async (status) => {
        for (const action of ['search', 'complete'] as const) {
            const { request, adapter } = mockHttp();
            request.mockRejectedValue(Object.assign(new Error('secret variables'), { isAxiosError: true, response: { status, data: 'secret' } }));
            const session = await adapter.connect({ restUrl: 'http://localhost/v2' });
            const result = action === 'search' ? session.search() : session.complete('1', {});
            await expect(result).rejects.toThrow(status === undefined ? 'failed' : `HTTP ${status}`);
            await expect(result).rejects.not.toThrow('secret');
            await expect(result).rejects.not.toHaveProperty('cause');
            await expect(result).rejects.not.toHaveProperty('response');
            expect(request).toHaveBeenCalledTimes(1);
        }
    });
    test.each(['{}', 'null', 'secret', '{"access_token":""}', '{"access_token":"dummy\\r\\nsecret"}'])(
        'invalid OAuth response %s stops before task requests', async (data) => {
            const { request, adapter } = mockHttp();
            request.mockResolvedValue({ status: 200, data });
            await expect(adapter.connect({ restUrl: 'http://localhost/v2', oauth })).rejects.toThrow('OAuth authentication');
            expect(request).toHaveBeenCalledTimes(1);
        });
    test('OAuth HTTP failure is sanitized and never retried', async () => {
        const { request, adapter } = mockHttp();
        request.mockRejectedValue(Object.assign(new Error('secret'), { isAxiosError: true, response: { status: 401 } }));
        const result = adapter.connect({ restUrl: 'http://localhost/v2', oauth });
        await expect(result).rejects.toThrow('OAuth authentication failed (HTTP 401)');
        await expect(result).rejects.not.toThrow('secret');
        expect(request).toHaveBeenCalledTimes(1);
    });
    test.each(['secret', 'null', '[]', '{}', '{"items":[]}', '{"items":{},"page":{}}',
        '{"items":[{}],"page":{}}',
        JSON.stringify({ items: [{ ...task(), key: 1 }], page: {} }),
        JSON.stringify({ items: [{ ...task(), state: 'COMPLETED' }], page: {} }),
        JSON.stringify({ items: [{ ...task(), assignee: {} }], page: {} })])('rejects malformed search %s', async (data) => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValue({ status: 200, data });
        await expect((await adapter.connect({ restUrl: 'http://localhost/v2' })).search()).rejects.toThrow('malformed');
        expect(request).toHaveBeenCalledTimes(1);
    });
    test.each([undefined, [], null, 'cursor'])('rejects missing/malformed nonempty-page cursor %j', async (cursor) => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValue({ status: 200, data: JSON.stringify({ items: [task()], page: { lastSortValues: cursor } }) });
        await expect((await adapter.connect({ restUrl: 'http://localhost/v2' })).search()).rejects.toThrow('cursor');
        expect(request).toHaveBeenCalledTimes(1);
    });
    test.each(['repeated', 'cyclic', 'duplicate', 'mismatch', 'backward dates', 'invalid dates', 'later failure', 'unexpected status'])(
        'rejects %s pagination without partial presentation', async (scenario) => {
            const { request, adapter } = mockHttp();
            request.mockResolvedValueOnce(page([task('1')], ['a']));
            if (scenario === 'repeated') request.mockResolvedValueOnce(page([task('2')], ['a']));
            if (scenario === 'cyclic') request.mockResolvedValueOnce(page([task('2')], ['b'])).mockResolvedValueOnce(page([task('3')], ['a']));
            if (scenario === 'duplicate') request.mockResolvedValueOnce(page([task('1')], ['b']));
            if (scenario === 'mismatch') request.mockResolvedValueOnce(page([{ ...task('2'), processInstanceKey: '2' }], ['b']));
            if (scenario === 'backward dates') request.mockResolvedValueOnce(page([{ ...task('2'), creationDate: '2025-01-01T00:00:00Z' }], ['b']));
            if (scenario === 'invalid dates') request.mockResolvedValueOnce(page([{ ...task('2'), creationDate: 'not a date' }], ['b']));
            if (scenario === 'later failure') request.mockRejectedValueOnce(new Error('secret'));
            if (scenario === 'unexpected status') request.mockResolvedValueOnce({ status: 201, data: page([]).data });
            const s = state();
            const result = new ListUserTasksUseCase(s, adapter, s).listUserTasks({ profile: 'on-prem', processInstance: large, json: true });
            await expect(result).rejects.toThrow();
            await expect(result).rejects.not.toThrow('secret');
            expect(s.showUserTasks).not.toHaveBeenCalled();
            expect(request.mock.calls.length).toBe(scenario === 'cyclic' ? 3 : 2);
        });
});

function overrideExits(cli: Command): void {
    cli.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    cli.commands.forEach(overrideExits);
}
const listArgs = ['usertasks', 'get', '--profile', 'on-prem'];
const completeArgs = ['usertask', large, 'complete', '--profile', 'on-prem', '--variablen', '{}'];

describe('user task CLI and presentation', () => {
    test('supports exact ordering, optional filter, JSON and normalized key', async () => {
        const listUserTasks = jest.fn();
        const completeUserTask = jest.fn();
        await createCamundaCli({ listUserTasksInPort: { listUserTasks } }).parseAsync(
            [...listArgs, '--filter', 'process-instance', ` 000${large} `, '--json'], { from: 'user' });
        expect(listUserTasks).toHaveBeenCalledWith({ profile: 'on-prem', processInstance: large, json: true });
        await createCamundaCli({ listUserTasksInPort: { listUserTasks } }).parseAsync(listArgs, { from: 'user' });
        expect(listUserTasks).toHaveBeenLastCalledWith({ profile: 'on-prem', processInstance: undefined, json: undefined });
        await createCamundaCli({ completeUserTaskInPort: { completeUserTask } }).parseAsync(completeArgs, { from: 'user' });
        expect(completeUserTask).toHaveBeenCalledWith({ id: large, profile: 'on-prem', variables: '{}' });
    });
    test.each([
        ['--filter'], ['--filter', 'process-instance'], ['--filter', 'unknown', '1'],
        ['--filter', 'process-instance', '1', 'extra'], ['--filter', 'process-instance', '0'],
        ['--filter', 'process-instance', '1', '--filter', 'process-instance', '2'],
        ['--filter', 'process-instance', '--filter', '1'], ['1'],
    ])('rejects invalid filters %j before dispatch', async (...extra) => {
        const listUserTasks = jest.fn();
        const cli = createCamundaCli({ listUserTasksInPort: { listUserTasks } });
        overrideExits(cli);
        await expect(cli.parseAsync([...listArgs, ...extra], { from: 'user' })).rejects.toThrow();
        expect(listUserTasks).not.toHaveBeenCalled();
    });
    test.each([
        ['usertasks', 'get'], ['usertasks', 'get', '--profile'],
        ['usertask', '1', 'complete', '--variablen', '{}'],
        ['usertask', '1', 'complete', '--profile', 'on-prem'],
        ['usertask', '1', 'complete', '--profile', 'on-prem', '--variablen'],
        ['usertask', '1', 'assign', '--profile', 'on-prem', '--variablen', '{}'],
        ['usertask', 'complete', '1', '--profile', 'on-prem', '--variablen', '{}'],
        [...completeArgs, 'extra'],
    ])('rejects missing options/unknown actions/extra args %j', async (...argv) => {
        const action = jest.fn();
        const cli = createCamundaCli({ listUserTasksInPort: { listUserTasks: action }, completeUserTaskInPort: { completeUserTask: action } });
        overrideExits(cli);
        await expect(cli.parseAsync(argv, { from: 'user' })).rejects.toThrow();
        expect(action).not.toHaveBeenCalled();
    });
    test('JSON is one array including [] and table escapes controls and bidi', () => {
        const write = jest.fn();
        const presenter = new ConsoleUserTasksPresenter(write);
        const unsafe = { ...task(), elementId: 'a\u001b[31m\n\u202eb', assignee: 'x\t\u2066\u061c\u200f' };
        presenter.showUserTasks([unsafe], true);
        expect(write.mock.calls).toHaveLength(1);
        expect(JSON.parse(write.mock.calls[0][0])).toEqual([unsafe]);
        presenter.showUserTasks([], true);
        expect(write).toHaveBeenLastCalledWith('[]');
        presenter.showUserTasks([unsafe, task('1')], false);
        const table = write.mock.calls[2][0];
        expect(table).toContain('USER TASK KEY');
        expect(table).toContain('PROCESS INSTANCE KEY');
        expect(table).toContain('a\\u001b[31m\\u000a\\u202eb');
        expect(table).toContain('x\\u0009\\u2066\\u061c\\u200f');
        expect(table).not.toContain('\u001b');
        presenter.showUserTasks([], false);
        expect(write.mock.calls[3][0]).toContain('USER TASK KEY');
        presenter.showCompleted(large);
        expect(write).toHaveBeenLastCalledWith(`Completed user task ${large}.`);
    });
});

describe('user task loopback transport and runtime', () => {
    let server: Server;
    let root: string;
    let home: string;
    let cwd: string;
    let calls: { url?: string; body: string; auth?: string; cookie?: string; proxyAuth?: string }[];
    let redirect: boolean;
    beforeEach(async () => {
        home = await fs.mkdtemp(path.join(tmpdir(), 'cli-usertasks-home-'));
        cwd = await fs.mkdtemp(path.join(tmpdir(), 'cli-usertasks-cwd-'));
        calls = [];
        redirect = false;
        server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                calls.push({ url: req.url, body: Buffer.concat(chunks).toString(), auth: req.headers.authorization,
                    cookie: req.headers.cookie, proxyAuth: req.headers['proxy-authorization'] as string | undefined });
                if (redirect) { res.writeHead(307, { Location: `${root}/must-not-follow` }); res.end(); }
                else if (req.url === '/token') { res.writeHead(200); res.end('{"access_token":"dummy"}'); }
                else if (req.url?.endsWith('/completion')) { res.writeHead(204); res.end(); }
                else { res.writeHead(200); res.end(page([]).data); }
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.rm(home, { recursive: true, force: true });
        await fs.rm(cwd, { recursive: true, force: true });
        jest.restoreAllMocks();
    });
    test('default bootstrap sends gateway searches/completion and fresh OAuth, never Operate', async () => {
        await new JsonProfileRepositoryAdapter(home, cwd).addProfile({ ...profile, baseUrl: `${root}/proxy/v2///`, ...oauth, oAuthUrl: `${root}/token` });
        const writeLine = jest.fn();
        const runtime = createDefaultCamundaCli({ homeDirectory: home, workingDirectory: cwd, writeLine });
        await runtime.parseAsync([...listArgs, '--json'], { from: 'user' });
        expect(writeLine.mock.calls).toEqual([['[]']]);
        await runtime.parseAsync(completeArgs, { from: 'user' });
        expect(calls.map((call) => call.url)).toEqual(['/token', '/proxy/v2/user-tasks/search', '/token', `/proxy/v2/user-tasks/${large}/completion`]);
        expect(calls[1].auth).toBe('Bearer dummy');
        expect(calls[3].body).toBe('{"variables":{}}');
        expect(writeLine).toHaveBeenLastCalledWith(`Completed user task ${large}.`);
    });
    test('noAuth strips inherited Basic, bearer, proxy auth and cookies without mutating defaults or authenticating', async () => {
        const http = axios.create({ auth: { username: 'dummy', password: 'secret' }, withCredentials: true,
            headers: { Authorization: 'Bearer inherited', Cookie: 'secret=cookie', 'Proxy-Authorization': 'Basic inherited' } });
        const session = await new AxiosUserTaskAdapter(http).connect({ restUrl: `${root}/v2`, noAuth: true, oauth });
        await session.search();
        await session.complete('1', {});
        expect(calls.map((call) => call.url)).toEqual(['/v2/user-tasks/search', '/v2/user-tasks/1/completion']);
        for (const call of calls) expect(call).toMatchObject({ auth: undefined, proxyAuth: undefined, cookie: undefined });
        expect(http.defaults.auth).toEqual({ username: 'dummy', password: 'secret' });
        expect(http.defaults.headers.Cookie).toBe('secret=cookie');
        expect(http.defaults.withCredentials).toBe(true);
    });
    test('redirects never follow or retry for search/completion', async () => {
        redirect = true;
        const session = await new AxiosUserTaskAdapter().connect({ restUrl: `${root}/v2` });
        await expect(session.search()).rejects.toThrow('HTTP 307');
        await expect(session.complete('1', {})).rejects.toThrow('HTTP 307');
        expect(calls).toHaveLength(2);
    });
    test.each(['usertasks', 'usertask'])('%s startup notices and failures never pollute stdout', async (command) => {
        const writeLine = jest.fn();
        const writeDiagnostic = jest.fn();
        const argv = command === 'usertasks' ? [...listArgs, '--json'] : completeArgs;
        await expect(runDefaultCamundaCli(['node', 'cli', ...argv], {
            homeDirectory: home, workingDirectory: cwd, writeLine, writeDiagnostic,
        })).rejects.toThrow('profile does not exist');
        expect(writeLine).not.toHaveBeenCalled();
        expect(writeDiagnostic).toHaveBeenCalled();
        expect(calls).toEqual([]);
    });
});
