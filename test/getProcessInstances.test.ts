import axios, { AxiosInstance, RawAxiosRequestConfig } from 'axios';
import { createServer, IncomingHttpHeaders } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    AxiosProcessInstanceSearchAdapter, ConsoleProcessInstancesPresenter, GetProcessInstancesUseCase,
    OperateConnection, Profile, QueriedProcessInstance, createCamundaCli, createDefaultCamundaCli,
    processInstanceFilter, processInstanceQueryFilter, runDefaultCamundaCli,
} from '../src';

const connection: OperateConnection = {
    operateUrl: 'https://operate.example/prefix/v1', oAuthUrl: 'https://auth.example/token',
    clientId: 'dummy-client', clientSecret: 'dummy-secret', audience: 'operate-audience',
};
const profile: Profile = { name: 'selected', baseUrl: 'unused', ...connection };
const max = '9223372036854775807';
const sample: QueriedProcessInstance = {
    key: '9007199254740993', bpmnProcessId: 'order', processVersion: 2, state: 'ACTIVE',
    incident: true, startDate: '2026-11-01T12:00:00Z', variables: [],
};
const empty = '{"items":[],"total":10000}';
function instance(key = sample.key, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ ...sample, key: 'KEY', variables: undefined, ...overrides }).replace('"KEY"', key);
}
function variable(key = '21', overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ key: 'KEY', processInstanceKey: 'INSTANCE', scopeKey: 'SCOPE', name: 'order',
        value: '{"secret":"full"}', truncated: false, ...overrides })
        .replace('"KEY"', key).replace('"INSTANCE"', sample.key).replace('"SCOPE"', sample.key);
}
function page(items: string[], cursor?: string): string {
    return `{"items":[${items.join(',')}],"sortValues":${cursor ?? `[${sample.key},"tie",null,${max}]`},"total":1}`;
}
function node(processInstanceKey = sample.key, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ key: 'NODE', processInstanceKey: 'INSTANCE', flowNodeId: 'task', state: 'ACTIVE', incident: true, ...overrides })
        .replace('"NODE"', max).replace('"INSTANCE"', processInstanceKey);
}
function mockAdapter(): { adapter: AxiosProcessInstanceSearchAdapter; send: jest.Mock } {
    const send = jest.fn();
    const request = jest.fn((config: RawAxiosRequestConfig) => send(config.url, config.data, config));
    return { adapter: new AxiosProcessInstanceSearchAdapter({ request, post: send } as unknown as AxiosInstance), send };
}
function script(send: jest.Mock, ...responses: string[]): void {
    for (const data of responses) send.mockResolvedValueOnce({ status: 200, data });
}

describe('query validation and orchestration', () => {
    test.each([undefined, '{}'])('accepts absent key %s', (filter) => {
        expect(processInstanceFilter(filter)).toBeUndefined();
        expect(processInstanceQueryFilter(filter)).toEqual({});
    });
    test('normalizes exact decimal string keys', () => {
        expect(processInstanceFilter(`{"process-instance":" 00${max} "}`)).toBe(max);
    });
    test.each([
        {}, { 'process-instance': '0001' }, { processDefinition: ' order ' },
        { 'process-instance': '1', processDefinition: 'order' }, { processDefinition: 'order', activity: ' task ' },
        { 'process-instance': '1', processDefinition: 'order', activity: 'task' },
    ])('passes structured AND filter %j unchanged except key normalization in both output modes', async (filter) => {
        const parsed = { ...(filter['process-instance'] ? { key: '1' } : {}),
            ...(filter.processDefinition ? { processDefinition: filter.processDefinition } : {}),
            ...(filter.activity ? { activity: filter.activity } : {}) };
        expect(processInstanceQueryFilter(JSON.stringify(filter))).toEqual(parsed);
        expect(processInstanceFilter(JSON.stringify(filter))).toBe(parsed.key);
        for (const json of [false, true]) {
            const searchActiveProcessInstances = jest.fn().mockResolvedValue([]);
            const showProcessInstances = jest.fn();
            await new GetProcessInstancesUseCase({ getProfile: () => profile }, { searchActiveProcessInstances }, { showProcessInstances })
                .getProcessInstances({ profile: 'selected', filter: JSON.stringify(filter), json });
            expect(searchActiveProcessInstances).toHaveBeenCalledWith(connection, { ...parsed, includeVariables: json });
            expect(showProcessInstances).toHaveBeenCalledWith([], json);
        }
    });
    test.each([
        { activity: 'task' }, { activity: 'task', 'process-instance': '1' },
        ...['processDefinition', 'activity'].flatMap((field) =>
            ['', ' \t ', null, [], {}, 1, true].map((value) => ({ processDefinition: 'order', [field]: value }))),
        { processDefinition: 'order', activityId: 'task' },
    ])('rejects invalid definition/activity filter %j before cached profile lookup', async (filter) => {
        const getProfile = jest.fn();
        const searchActiveProcessInstances = jest.fn();
        const showProcessInstances = jest.fn();
        await expect(new GetProcessInstancesUseCase({ getProfile }, { searchActiveProcessInstances }, { showProcessInstances })
            .getProcessInstances({ profile: 'selected', filter: JSON.stringify(filter) })).rejects.toThrow('Filter must');
        expect(getProfile).not.toHaveBeenCalled();
        expect(searchActiveProcessInstances).not.toHaveBeenCalled();
        expect(showProcessInstances).not.toHaveBeenCalled();
    });
    test.each(['', '{secret', '[]', 'null', 'true', '"1"', '1', '{"state":"ACTIVE"}', '{"process-instance":1}',
        ...['0', '-1', '1.2', '1e3', '9223372036854775808', ''].map((key) => JSON.stringify({ 'process-instance': key })),
    ])('rejects invalid filter before profile or transport I/O: %s', async (filter) => {
        const getProfile = jest.fn();
        const searchActiveProcessInstances = jest.fn();
        const showProcessInstances = jest.fn();
        await expect(new GetProcessInstancesUseCase({ getProfile }, { searchActiveProcessInstances }, { showProcessInstances })
            .getProcessInstances({ profile: 'selected', filter })).rejects.toThrow('Filter must');
        expect(getProfile).not.toHaveBeenCalled();
        expect(searchActiveProcessInstances).not.toHaveBeenCalled();
        expect(showProcessInstances).not.toHaveBeenCalled();
    });
    test.each([false, true])('normalizes profile and selects variable loading only for json=%s', async (json) => {
        const getProfile = jest.fn().mockReturnValue({ ...profile, operateAudience: 'override', operateUrl: `${connection.operateUrl}///` });
        const searchActiveProcessInstances = jest.fn().mockResolvedValue([]);
        const showProcessInstances = jest.fn();
        await new GetProcessInstancesUseCase({ getProfile }, { searchActiveProcessInstances }, { showProcessInstances })
            .getProcessInstances({ profile: ' selected ', filter: '{"process-instance":"0001"}', json });
        expect(getProfile).toHaveBeenCalledWith('selected');
        expect(searchActiveProcessInstances).toHaveBeenCalledWith({ ...connection, audience: 'override' }, { key: '1', includeVariables: json });
        expect(showProcessInstances).toHaveBeenCalledWith([], json);
    });
    test.each(['', ' \t ', 'unknown'])('rejects missing/blank profile %j', async (name) => {
        const searchActiveProcessInstances = jest.fn();
        await expect(new GetProcessInstancesUseCase({ getProfile: () => undefined }, { searchActiveProcessInstances },
            { showProcessInstances: jest.fn() }).getProcessInstances({ profile: name })).rejects.toThrow(/nonblank|does not exist/);
        expect(searchActiveProcessInstances).not.toHaveBeenCalled();
    });
    test('does not publish a partial result when late variable detail fails', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy.token"}', page([instance()]), empty,
            page([variable('21', { truncated: true })], '[21]'), empty, '{"secret":"bad-detail"}');
        const showProcessInstances = jest.fn();
        await expect(new GetProcessInstancesUseCase({ getProfile: () => profile }, adapter, { showProcessInstances })
            .getProcessInstances({ profile: 'selected', json: true })).rejects.toThrow('inconsistent');
        expect(showProcessInstances).not.toHaveBeenCalled();
    });
});

describe('read-only Operate query transport', () => {
    test('authenticates once and follows short instance pages until empty, ignoring capped totals', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy.token"}', page([instance()]), page([instance(max)], `[${max}]`), empty);
        expect(await adapter.searchActiveProcessInstances(connection, { includeVariables: false })).toEqual([sample, { ...sample, key: max }]);
        expect(send).toHaveBeenCalledTimes(4);
        expect(Object.fromEntries(new URLSearchParams(send.mock.calls[0][1]))).toEqual({
            grant_type: 'client_credentials', client_id: 'dummy-client', client_secret: 'dummy-secret', audience: 'operate-audience',
        });
        for (const [url, body, config] of send.mock.calls.slice(1)) {
            expect(url).toBe('https://operate.example/prefix/v1/process-instances/search');
            expect(body).toContain('"filter":{"state":"ACTIVE"}');
            expect(body).toContain('"size":100,"sort":[{"field":"key","order":"ASC"}]');
            expect(config).toMatchObject({ timeout: 30000, maxRedirects: 0, responseType: 'text' });
        }
        expect(send.mock.calls[2][1]).toContain(`"searchAfter":[${sample.key},"tie",null,${max}]`);
    });
    test('uses an exact max int64 numeric filter and preserves string cursors', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance(max)], `["${max}",null,"tie"]`), empty);
        const results = await adapter.searchActiveProcessInstances(connection, { key: max, includeVariables: false });
        expect(results[0].key).toBe(max);
        expect(send.mock.calls[1][1]).toContain(`"key":${max}`);
        expect(send.mock.calls[2][1]).toContain(`"searchAfter":["${max}",null,"tie"]`);
    });
    test('loads all variable scopes/pages per instance, hydrates full values and resets cursor', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance(), instance(max)], `[${max}]`), empty,
            page([variable('21')], '[21,"a",null]'),
            page([variable('22', { scopeKey: '42', truncated: true, value: 'trunc' })], '[22]'), empty,
            variable('22', { scopeKey: '42', value: '"full\\nvalue"' }), empty);
        const results = await adapter.searchActiveProcessInstances(connection, { includeVariables: true });
        expect(results[0].variables).toEqual([
            { key: '21', processInstanceKey: sample.key, scopeKey: sample.key, name: 'order', value: '{"secret":"full"}', truncated: false },
            { key: '22', processInstanceKey: sample.key, scopeKey: '42', name: 'order', value: '"full\\nvalue"', truncated: false },
        ]);
        expect(results[1].variables).toEqual([]);
        expect(send.mock.calls[3][1]).toContain(`"processInstanceKey":${sample.key}`);
        expect(send.mock.calls[4][1]).toContain('"searchAfter":[21,"a",null]');
        expect(send.mock.calls[6][0]).toBe('https://operate.example/prefix/v1/variables/22');
        expect(send.mock.calls[7][1]).toContain(`"processInstanceKey":${max}`);
        expect(send.mock.calls[7][1]).not.toContain('searchAfter');
    });
    test('accepts optional metadata, root sentinels, and preserves exact keys', async () => {
        const { adapter, send } = mockAdapter();
        const metadata = { parentKey: null, parentFlowNodeInstanceKey: '-1', processDefinitionKey: max,
            processVersionTag: 'v2', endDate: null, tenantId: 'tenant' };
        script(send, '{"access_token":"dummy"}', page([instance(sample.key, metadata)]), empty);
        expect((await adapter.searchActiveProcessInstances(connection, { includeVariables: false }))[0]).toEqual({ ...sample, ...metadata });
    });
    test('preserves numeric max int64 variable/detail/scope identity exactly', async () => {
        const { adapter, send } = mockAdapter();
        const full = variable(max).replace(`"scopeKey":${sample.key}`, `"scopeKey":${max}`);
        const truncated = full.replace('"truncated":false', '"truncated":true');
        script(send, '{"access_token":"dummy"}', page([instance()]), empty, page([truncated], `[${max},null]`), empty, full);
        const results = await adapter.searchActiveProcessInstances(connection, { includeVariables: true });
        expect(results[0].variables[0]).toMatchObject({ key: max, scopeKey: max, processInstanceKey: sample.key, truncated: false });
        expect(send.mock.calls[5][0]).toBe(`https://operate.example/prefix/v1/variables/${max}`);
        expect(send.mock.calls[4][1]).toContain(`"searchAfter":[${max},null]`);
    });
    test.each([
        { state: 'COMPLETED' }, { key: '2' }, { incident: 'false' }, { processVersion: 0 }, { startDate: 'bad' },
        { processDefinitionKey: '9223372036854775808' }, { tenantId: null },
    ])('rejects foreign/invalid instance data %j', async (overrides) => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance(sample.key, overrides)]));
        await expect(adapter.searchActiveProcessInstances(connection, { key: sample.key, includeVariables: false })).rejects.toThrow('inconsistent');
    });
    test.each([
        { processInstanceKey: '1' }, { scopeKey: null }, { key: '0' }, { name: null }, { value: null },
        { truncated: undefined }, { tenantId: 'foreign' },
    ])('rejects malformed or foreign variable %j', async (overrides) => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance(sample.key, { tenantId: 'tenant' })]), empty,
            page([variable('21', overrides)], '[21]'));
        await expect(adapter.searchActiveProcessInstances(connection, { includeVariables: true })).rejects.toThrow('inconsistent');
    });
    test.each([
        { key: '22' }, { processInstanceKey: '1' }, { scopeKey: '1' }, { name: 'foreign' },
        { truncated: true }, { value: null }, { tenantId: 'foreign' },
    ])('rejects incomplete/foreign variable detail %j', async (overrides) => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance()]), empty,
            page([variable('21', { truncated: true, tenantId: 'tenant' })], '[21]'), empty,
            variable('21', { tenantId: 'tenant', ...overrides }));
        await expect(adapter.searchActiveProcessInstances(connection, { includeVariables: true })).rejects.toThrow('inconsistent');
    });
    test.each(['null', '[]', '{}', '[null]', '["bad"]', `[${max}]`, '[{"isLosslessNumber":true,"value":"1"}]'])(
        'rejects malformed or mismatched cursor %s', async (cursor) => {
            const { adapter, send } = mockAdapter();
            script(send, '{"access_token":"dummy"}', page([instance()], cursor));
            await expect(adapter.searchActiveProcessInstances(connection, { includeVariables: false })).rejects.toThrow('inconsistent');
        });
    test.each([sample.key, '1'])('rejects duplicate/regressing page key %s', async (key) => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance()]), page([instance(key)], `[${key}]`));
        await expect(adapter.searchActiveProcessInstances(connection, { includeVariables: false })).rejects.toThrow('inconsistent');
    });
    test('rejects nonprogressing variable pages independently of instance pagination', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance()]), empty,
            page([variable()], '[21]'), page([variable()], '[21]'));
        await expect(adapter.searchActiveProcessInstances(connection, { includeVariables: true })).rejects.toThrow('inconsistent');
    });
    test.each(['oauth', 'instance', 'variable', 'detail'])('sanitizes HTTP and JSON errors in %s', async (stage) => {
        for (const malformed of [false, true]) {
            const { adapter, send } = mockAdapter();
            const stages = ['{"access_token":"dummy"}', page([instance()]), empty,
                page([variable('21', { truncated: true })], '[21]'), empty];
            const before = { oauth: 0, instance: 1, variable: 3, detail: 5 }[stage]!;
            script(send, ...stages.slice(0, before));
            if (malformed) script(send, 'secret invalid JSON');
            else send.mockRejectedValueOnce(new Error('secret credentials value body'));
            const result = adapter.searchActiveProcessInstances(connection, { includeVariables: true });
            await expect(result).rejects.toThrow(/malformed JSON|failed/);
            await expect(result).rejects.not.toThrow('secret');
        }
    });
    test('no matches returns [] without querying variables', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', empty);
        expect(await adapter.searchActiveProcessInstances(connection, { includeVariables: true })).toEqual([]);
        expect(send).toHaveBeenCalledTimes(2);
    });
});

describe('definition and current activity intersection', () => {
    test('combines exact selectors and preserves complete double-key cursors across versions and tenants', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}',
            page([instance(sample.key, { tenantId: 'one' })], `[${sample.key},${sample.key}]`),
            page([instance(max, { processVersion: 3, tenantId: 'two' })], `["${max}","${max}"]`), empty);
        const results = await adapter.searchActiveProcessInstances(connection, { processDefinition: 'order', includeVariables: false });
        expect(results.map((result) => [result.key, result.processVersion, result.tenantId])).toEqual([
            [sample.key, 2, 'one'], [max, 3, 'two'],
        ]);
        expect(send.mock.calls[1][1]).toContain('"filter":{"state":"ACTIVE","bpmnProcessId":"order"}');
        expect(send.mock.calls[2][1]).toContain(`"searchAfter":[${sample.key},${sample.key}]`);
        expect(send.mock.calls[3][1]).toContain(`"searchAfter":["${max}","${max}"]`);
        expect(send).toHaveBeenCalledTimes(4);
    });
    test('preserves exact BPMN ID bytes with lossless key AND filtering', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance(max, { bpmnProcessId: ' order ' })], `[${max},${max}]`), empty);
        expect(await adapter.searchActiveProcessInstances(connection,
            { key: max, processDefinition: ' order ', includeVariables: false })).toHaveLength(1);
        expect(send.mock.calls[1][1]).toContain(`"filter":{"state":"ACTIVE","key":${max},"bpmnProcessId":" order "}`);
    });
    test('rejects a returned definition selector mismatch', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance()]));
        await expect(adapter.searchActiveProcessInstances(connection, { processDefinition: 'foreign', includeVariables: false })).rejects.toThrow('inconsistent');
    });
    test.each([false, true])('intersects all candidates before variables, with no duplicated output, json=%s', async (includeVariables) => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}',
            page([instance(sample.key, { processDefinitionKey: '42', tenantId: 'one' }),
                instance(max, { processVersion: 3, tenantId: 'two' })], `[${max},${max}]`), empty,
            // Multiple active executions/large total still prove only existence.
            `{"items":[${node(sample.key, { processDefinitionKey: '42', tenantId: 'one', type: 'MULTI_INSTANCE_BODY' })},
                ${node(sample.key, { key: '43', type: 'SERVICE_TASK' })}],"total":10000}`, empty,
            ...(includeVariables ? [page([variable('21', { truncated: true })], '[21,21]'), empty, variable()] : []));
        const results = await adapter.searchActiveProcessInstances(connection,
            { processDefinition: 'order', activity: 'task', includeVariables });
        expect(results.map((result) => result.key)).toEqual([sample.key]);
        expect(results[0].variables).toHaveLength(includeVariables ? 1 : 0);
        for (const [index, key] of [[3, sample.key], [4, max]] as const) {
            const [url, body, config] = send.mock.calls[index];
            expect(url).toBe('https://operate.example/prefix/v1/flownode-instances/search');
            expect(body).toBe(`{"filter":{"processInstanceKey":${key},"flowNodeId":"task","state":"ACTIVE"},"size":1,"sort":[{"field":"key","order":"ASC"}]}`);
            expect(config).toMatchObject({ timeout: 30000, maxRedirects: 0 });
        }
        expect(send).toHaveBeenCalledTimes(includeVariables ? 8 : 5);
    });
    test('accepts absent legacy definition/tenant metadata and exact activity ID bytes', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance()]), empty,
            `{"items":[${node(sample.key, { flowNodeId: ' task ' })}]}`);
        expect(await adapter.searchActiveProcessInstances(connection,
            { key: sample.key, processDefinition: 'order', activity: ' task ', includeVariables: false })).toEqual([sample]);
        expect(send.mock.calls[3][1]).toContain('"flowNodeId":" task "');
    });
    test('retains matching versions and tenants when either side lacks optional legacy metadata', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}',
            page([instance(sample.key, { processDefinitionKey: '42', tenantId: 'one' })], `[${sample.key},${sample.key}]`),
            page([instance(max, { processVersion: 3, tenantId: 'two' })], `[${max},${max}]`), empty,
            `{"items":[${node()}]}`, `{"items":[${node(max, { processDefinitionKey: '43' })}]}`);
        const results = await adapter.searchActiveProcessInstances(connection,
            { processDefinition: 'order', activity: 'task', includeVariables: false });
        expect(results.map((result) => [result.key, result.processVersion, result.tenantId])).toEqual([
            [sample.key, 2, 'one'], [max, 3, 'two'],
        ]);
        expect(send).toHaveBeenCalledTimes(6);
    });
    test.each([false, true])('empty activity intersection returns [] without variables, json=%s', async (includeVariables) => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance()]), empty, empty);
        expect(await adapter.searchActiveProcessInstances(connection, { processDefinition: 'order', activity: 'unknown', includeVariables })).toEqual([]);
        expect(send).toHaveBeenCalledTimes(4);
    });
    test('empty candidate list skips node and variable requests', async () => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', empty);
        expect(await adapter.searchActiveProcessInstances(connection,
            { processDefinition: 'unknown', activity: 'task', includeVariables: true })).toEqual([]);
        expect(send).toHaveBeenCalledTimes(2);
    });
    test.each([
        { key: null }, { key: '0' }, { processInstanceKey: '1' }, { flowNodeId: 'elsewhere' },
        { state: 'COMPLETED' }, { state: 'TERMINATED' }, { processDefinitionKey: '43' },
        { processDefinitionKey: null }, { tenantId: 'foreign' }, { tenantId: null }, { incident: 'true' },
    ])('rejects malformed or foreign node identity %j', async (overrides) => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance(sample.key, { processDefinitionKey: '42', tenantId: 'one' })]),
            empty, `{"items":[${node(sample.key, overrides)}]}`);
        await expect(adapter.searchActiveProcessInstances(connection,
            { processDefinition: 'order', activity: 'task', includeVariables: false })).rejects.toThrow('inconsistent');
    });
    test.each(['{}', '{"items":null}', '{"items":[null]}', 'null'])('rejects malformed node page %s', async (response) => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance()]), empty, response);
        await expect(adapter.searchActiveProcessInstances(connection,
            { processDefinition: 'order', activity: 'task', includeVariables: false })).rejects.toThrow('inconsistent');
    });
    test.each([false, true])('late node failure aborts all publication and sanitizes errors, malformed=%s', async (malformed) => {
        const { adapter, send } = mockAdapter();
        script(send, '{"access_token":"dummy"}', page([instance(), instance(max)], `[${max},${max}]`), empty, `{"items":[${node()}]}`);
        if (malformed) script(send, 'sensitive malformed body');
        else send.mockRejectedValueOnce(new Error('sensitive transport configuration'));
        const showProcessInstances = jest.fn();
        const result = new GetProcessInstancesUseCase({ getProfile: () => profile }, adapter, { showProcessInstances })
            .getProcessInstances({ profile: 'selected', filter: '{"processDefinition":"order","activity":"task"}', json: true });
        await expect(result).rejects.toThrow(/Operate activity query.*(?:failed|malformed JSON)/);
        await expect(result).rejects.not.toThrow('sensitive');
        expect(showProcessInstances).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(5);
    });
});

describe('real Axios authentication and bootstrap', () => {
    test('sends one OAuth token on every Operate request, then reuses the adapter anonymously without retained credentials', async () => {
        const requests: { url: string; method?: string; headers: IncomingHttpHeaders; body: string }[] = [];
        const queryResponses = [page([instance()]), empty, `{"items":[${node()}]}`, page([variable('21', { truncated: true })], '[21]'), empty, variable()];
        const responses = [...queryResponses, ...queryResponses];
        const server = createServer(async (request, response) => {
            let body = '';
            for await (const chunk of request) body += String(chunk);
            requests.push({ url: request.url!, method: request.method, headers: request.headers, body });
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(request.url === '/oauth/token' ? '{"access_token":"dummy.loopback-token"}' : responses.shift() ?? empty);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const operateUrl = `${origin}/prefix/v1`;
        const http = axios.create();
        const adapter = new AxiosProcessInstanceSearchAdapter(http);
        const expectedPaths = [
            '/prefix/v1/process-instances/search', '/prefix/v1/process-instances/search',
            '/prefix/v1/flownode-instances/search',
            '/prefix/v1/variables/search', '/prefix/v1/variables/search', '/prefix/v1/variables/21',
        ];
        try {
            const authenticated = await adapter.searchActiveProcessInstances(
                { ...connection, operateUrl, oAuthUrl: `${origin}/oauth/token` }, { processDefinition: 'order', activity: 'task', includeVariables: true });
            expect(authenticated[0].variables[0]).toMatchObject({ key: '21', truncated: false, value: '{"secret":"full"}' });
            expect(requests[0]).toMatchObject({ url: '/oauth/token', method: 'POST' });
            expect(Object.fromEntries(new URLSearchParams(requests[0].body))).toEqual({
                grant_type: 'client_credentials', client_id: 'dummy-client', client_secret: 'dummy-secret', audience: 'operate-audience',
            });
            expect(requests.slice(1).map((request) => request.url)).toEqual(expectedPaths);
            expect(requests.slice(1).map((request) => request.method)).toEqual(['POST', 'POST', 'POST', 'POST', 'POST', 'GET']);
            expect(requests.slice(1).map((request) => request.headers.authorization)).toEqual(Array(6).fill('Bearer dummy.loopback-token'));

            // Pollute the same transport after authentication, including Basic auth,
            // so the second invocation exercises both token isolation and stripping.
            http.defaults.headers.common.Authorization = 'Bearer dummy.retained-token';
            http.defaults.headers.common.Cookie = 'dummy-session=secret';
            http.defaults.headers.common['Proxy-Authorization'] = 'Basic dummy-proxy-secret';
            http.defaults.auth = { username: 'dummy-basic', password: 'dummy-secret' };
            const anonymous = await adapter.searchActiveProcessInstances({ operateUrl, noAuth: true },
                { processDefinition: 'order', activity: 'task', includeVariables: true });
            expect(anonymous).toEqual(authenticated);
            const anonymousRequests = requests.slice(7);
            expect(anonymousRequests.map((request) => request.url)).toEqual(expectedPaths);
            expect(anonymousRequests.map((request) => request.method)).toEqual(['POST', 'POST', 'POST', 'POST', 'POST', 'GET']);
            for (const request of anonymousRequests) {
                expect(request.headers.authorization).toBeUndefined();
                expect(request.headers.cookie).toBeUndefined();
                expect(request.headers['proxy-authorization']).toBeUndefined();
            }
            expect(requests.filter((request) => request.url === '/oauth/token')).toHaveLength(1);
            expect(responses).toHaveLength(0);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
    test('refuses OAuth redirects without following Location or starting an Operate query', async () => {
        const paths: string[] = [];
        const server = createServer((request, response) => {
            paths.push(request.url!);
            if (request.url === '/oauth/token') {
                response.writeHead(302, { Location: '/redirected-token' });
                response.end('dummy-sensitive-redirect-body');
            } else {
                response.writeHead(200);
                response.end(request.url === '/redirected-token' ? '{"access_token":"dummy.redirect-token"}' : empty);
            }
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const result = new AxiosProcessInstanceSearchAdapter(axios.create()).searchActiveProcessInstances(
                { ...connection, operateUrl: `${origin}/prefix/v1`, oAuthUrl: `${origin}/oauth/token` }, { includeVariables: true });
            await expect(result).rejects.toThrow('OAuth authentication failed (HTTP 302)');
            await expect(result).rejects.not.toThrow('dummy-sensitive-redirect-body');
            expect(paths).toEqual(['/oauth/token']);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
    test('refuses flow-node redirects without following Location or loading variables', async () => {
        const paths: string[] = [];
        let instancePage = 0;
        const server = createServer((request, response) => {
            paths.push(request.url!);
            if (request.url === '/prefix/v1/process-instances/search') {
                response.writeHead(200);
                response.end(instancePage++ === 0 ? page([instance()]) : empty);
            } else {
                response.writeHead(302, { Location: '/must-not-follow' });
                response.end('sensitive-node-body');
            }
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const operateUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix/v1`;
        try {
            const result = new AxiosProcessInstanceSearchAdapter(axios.create()).searchActiveProcessInstances(
                { operateUrl, noAuth: true }, { processDefinition: 'order', activity: 'task', includeVariables: true });
            await expect(result).rejects.toThrow('Operate activity query failed (HTTP 302)');
            await expect(result).rejects.not.toThrow('sensitive-node-body');
            expect(paths).toEqual([
                '/prefix/v1/process-instances/search', '/prefix/v1/process-instances/search', '/prefix/v1/flownode-instances/search',
            ]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
    test('strips polluted credentials on every search/detail, uses prefix and refuses redirects', async () => {
        const requests: { url: string; auth?: string; cookie?: string; body: string }[] = [];
        const responses = [page([instance()]), empty, page([variable('21', { truncated: true })], '[21]'), empty, variable()];
        const server = createServer(async (request, response) => {
            let body = '';
            for await (const chunk of request) body += String(chunk);
            requests.push({ url: request.url!, auth: request.headers.authorization, cookie: request.headers.cookie, body });
            response.writeHead(responses.length ? 200 : 302, { Location: '/must-not-follow' });
            response.end(responses.shift() ?? 'secret redirect');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const operateUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix/v1`;
        const http = axios.create({ headers: { Authorization: 'Bearer secret', Cookie: 'secret' }, auth: { username: 'secret', password: 'secret' } });
        try {
            const adapter = new AxiosProcessInstanceSearchAdapter(http);
            expect((await adapter.searchActiveProcessInstances({ operateUrl, noAuth: true }, { includeVariables: true }))[0].variables[0].key).toBe('21');
            expect(requests.map((request) => request.url)).toEqual([
                '/prefix/v1/process-instances/search', '/prefix/v1/process-instances/search',
                '/prefix/v1/variables/search', '/prefix/v1/variables/search', '/prefix/v1/variables/21',
            ]);
            expect(requests.every((request) => request.auth === undefined && request.cookie === undefined)).toBe(true);
            await expect(adapter.searchActiveProcessInstances({ operateUrl, noAuth: true }, { includeVariables: false })).rejects.toThrow('HTTP 302');
            expect(requests).toHaveLength(6);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
    test('wires cached local profiles and keeps JSON notices on diagnostic channel', async () => {
        const home = await mkdtemp(path.join(tmpdir(), 'query-home-'));
        const cwd = await mkdtemp(path.join(tmpdir(), 'query-cwd-'));
        const server = createServer((_request, response) => { response.writeHead(200); response.end(empty); });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const local = { name: 'selected', baseUrl: 'unused', noAuth: true,
            operateUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
        try {
            await mkdir(path.join(home, '.lmoesle-camunda-cli'));
            await writeFile(path.join(home, '.lmoesle-camunda-cli/profiles.json'), '{"profiles":[]}');
            await mkdir(path.join(cwd, '.lmoesle-camunda-cli'));
            await writeFile(path.join(cwd, '.lmoesle-camunda-cli/profiles.json'), JSON.stringify({ profiles: [local] }));
            const writeLine = jest.fn();
            const writeDiagnostic = jest.fn();
            const runtime = createDefaultCamundaCli({ homeDirectory: home, workingDirectory: cwd, writeLine, writeDiagnostic });
            await runtime.initialize();
            await writeFile(path.join(cwd, '.lmoesle-camunda-cli/profiles.json'), '{"profiles":[]}');
            await runtime.parseAsync(['process-instances', 'get', '--profile', 'selected', '--json'], { from: 'user' });
            expect(writeLine).toHaveBeenLastCalledWith('[]');
            writeLine.mockClear();
            await runDefaultCamundaCli(['node', 'cli', 'process-instances', 'get', '--profile', 'missing', '--json'],
                { homeDirectory: home, workingDirectory: cwd, writeLine, writeDiagnostic }).catch(() => undefined);
            expect(writeLine).not.toHaveBeenCalled();
            await rm(path.join(home, '.lmoesle-camunda-cli'), { recursive: true });
            await rm(path.join(cwd, '.lmoesle-camunda-cli'), { recursive: true });
            await expect(runDefaultCamundaCli(['node', 'cli', 'process-instances', 'get', '--profile', 'missing', '--json'],
                { homeDirectory: home, workingDirectory: cwd, writeLine, writeDiagnostic })).rejects.toThrow('does not exist');
            expect(writeDiagnostic).toHaveBeenCalledTimes(1);
            expect(writeLine).not.toHaveBeenCalled();
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(home, { recursive: true, force: true });
            await rm(cwd, { recursive: true, force: true });
        }
    });
});

describe('presentation and nested help', () => {
    test('prints one pretty JSON array with exact metadata and variable values', () => {
        const write = jest.fn();
        const result: QueriedProcessInstance = { ...sample, processDefinitionKey: max, tenantId: 'tenant',
            variables: [{ key: max, scopeKey: max, processInstanceKey: sample.key, name: 'value', value: '{"secret":9007199254740993}', truncated: false }] };
        new ConsoleProcessInstancesPresenter(write).showProcessInstances([result], true);
        expect(write.mock.calls).toEqual([[JSON.stringify([result], null, 2)]]);
        new ConsoleProcessInstancesPresenter(write).showProcessInstances([], true);
        expect(write).toHaveBeenLastCalledWith('[]');
    });
    test('escapes controls/ANSI/bidi in tables, omits values and reports empty results', () => {
        const write = jest.fn();
        new ConsoleProcessInstancesPresenter(write).showProcessInstances([{ ...sample, bpmnProcessId: 'a\n\u001b[31m\u202e', tenantId: 't\t',
            variables: [{ key: '21', scopeKey: sample.key, processInstanceKey: sample.key, name: 'secret', value: '"sensitive-secret"', truncated: false }] }], false);
        expect(write.mock.calls[0][0]).toContain('a\\u000a\\u001b[31m\\u202e');
        expect(write.mock.calls[0][0]).toContain('t\\u0009');
        expect(write.mock.calls[0][0]).not.toContain('VALUE');
        expect(write.mock.calls[0][0]).not.toContain('sensitive-secret');
        new ConsoleProcessInstancesPresenter(write).showProcessInstances([], false);
        expect(write).toHaveBeenLastCalledWith('No ACTIVE process instances found.');
    });
    test('requires profile and exposes nested get help', async () => {
        const program = createCamundaCli({});
        const get = program.commands.find((command) => command.name() === 'process-instances')!.commands[0];
        get.exitOverride().configureOutput({ writeErr: () => undefined });
        expect(get.helpInformation()).toMatch(/--filter/);
        expect(get.helpInformation()).toMatch(/--json/);
        await expect(program.parseAsync(['process-instances', 'get'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    });
});
