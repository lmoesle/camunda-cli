import axios, { AxiosInstance } from 'axios';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Command } from 'commander';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    AxiosIncidentAdapter, ConsoleIncidentsPresenter, createCamundaCli, createDefaultCamundaCli,
    Incident, IncidentConnection, JsonProfileRepositoryAdapter, ListIncidentsUseCase, Profile, runDefaultCamundaCli,
} from '../src';

const connection: IncidentConnection = {
    operateUrl: 'https://operate.example/proxy/cluster', oAuthUrl: 'https://auth.example/token',
    clientId: 'dummy-client', clientSecret: ' dummy+secret&= / ',
};
const profile: Profile = { name: 'selected', baseUrl: 'xxx', zeebeUrl: 'unused', ...connection };
const sample: Incident = {
    key: '9007199254740993', processInstanceKey: '9007199254740995', processDefinitionKey: '9007199254740997',
    jobKey: '9007199254740999', type: 'JOB_NO_RETRIES', message: 'Fix this\n\u001b[31merror\u009b0m\u202e!',
    creationTime: '2026-10-02T10:00:00.000Z', state: 'ACTIVE', tenantId: 'tenant',
};
// These literals are deliberately raw numeric JSON: JSON.stringify(Number(...)) would already lose precision.
function page(key = '9007199254740993', cursor = `[${key},"tie-breaker",9007199254740999]`): string {
    return `{"items":[{"key":${key},"processInstanceKey":9007199254740995,"processDefinitionKey":9007199254740997,
        "jobKey":9007199254740999,"type":"JOB_NO_RETRIES","message":${JSON.stringify(sample.message)},
        "creationTime":"2026-10-02T10:00:00.000Z","state":"ACTIVE","tenantId":"tenant"}],
        "sortValues":${cursor},"total":10000}`;
}
const empty = '{"items":[],"total":10000}';

function mockAdapter(): { adapter: AxiosIncidentAdapter; post: jest.Mock } {
    const post = jest.fn();
    return { adapter: new AxiosIncidentAdapter({ post } as unknown as AxiosInstance), post };
}

describe('incidents profile validation and orchestration', () => {
    const fields = ['operateUrl', 'oAuthUrl', 'clientId', 'clientSecret'] as const;
    test.each(fields.flatMap((field) => [undefined, '', ' \t '].map((value) => ({ field, value }))))(
        'rejects $field=$value before any request', async ({ field, value }) => {
            const { adapter, post } = mockAdapter();
            const showIncidents = jest.fn();
            const usecase = new ListIncidentsUseCase({ getProfile: () => ({ ...profile, [field]: value }) }, adapter, { showIncidents });
            await expect(usecase.listIncidents({ profile: 'selected' })).rejects.toThrow(field);
            expect(post).not.toHaveBeenCalled();
            expect(showIncidents).not.toHaveBeenCalled();
        },
    );

    test.each(['operateUrl', 'oAuthUrl'] as const)('rejects invalid %s safely', async (field) => {
        for (const value of ['xxx', 'ftp://secret.example', 'https://user:dummy-secret@host',
            'https://host?dummy-secret=x', 'https://host#dummy-secret', 'https://host?', 'https://host#']) {
            const { adapter, post } = mockAdapter();
            const usecase = new ListIncidentsUseCase({ getProfile: () => ({ ...profile, [field]: value }) }, adapter, { showIncidents: jest.fn() });
            await expect(usecase.listIncidents({ profile: 'selected' })).rejects.toThrow(field);
            await expect(usecase.listIncidents({ profile: 'selected' })).rejects.not.toThrow('dummy-secret');
            expect(post).not.toHaveBeenCalled();
        }
    });

    test.each([
        { operateUrl: 'https://bru-1.operate.camunda.io/cluster' },
        { oAuthUrl: 'https://login.cloud.camunda.io/oauth/token' },
        { audience: '' }, { audience: ' \t ' },
    ])('requires a nonblank audience for %j', async (overrides) => {
        const { adapter, post } = mockAdapter();
        const usecase = new ListIncidentsUseCase({ getProfile: () => ({ ...profile, ...overrides }) }, adapter, { showIncidents: jest.fn() });
        await expect(usecase.listIncidents({ profile: 'selected' })).rejects.toThrow('audience');
        expect(post).not.toHaveBeenCalled();
    });

    test.each([undefined, ' custom-audience '])('forwards selected profile and audience %j verbatim, normalizing only URLs/name', async (audience) => {
        const selected = { ...profile, audience, operateUrl: 'https://operate.example/proxy/cluster/v1///', oAuthUrl: 'https://auth.example/token/' };
        const getProfile = jest.fn((name: string) => name === 'selected' ? selected : undefined);
        const searchActiveIncidents = jest.fn().mockResolvedValue([sample]);
        const showIncidents = jest.fn();
        const usecase = new ListIncidentsUseCase({ getProfile }, { searchActiveIncidents }, { showIncidents });
        await usecase.listIncidents({ profile: ' selected ', json: true });
        expect(getProfile).toHaveBeenCalledWith('selected');
        expect(searchActiveIncidents).toHaveBeenCalledWith({ ...connection, audience,
            operateUrl: 'https://operate.example/proxy/cluster/v1', oAuthUrl: 'https://auth.example/token' });
        expect(showIncidents).toHaveBeenCalledWith([sample], true);
    });

    test('blank and unknown names fail clearly without searching or presenting', async () => {
        const searchActiveIncidents = jest.fn();
        const showIncidents = jest.fn();
        const usecase = new ListIncidentsUseCase({ getProfile: () => undefined }, { searchActiveIncidents }, { showIncidents });
        await expect(usecase.listIncidents({ profile: ' \t ' })).rejects.toThrow('nonblank profile');
        await expect(usecase.listIncidents({ profile: 'unknown' })).rejects.toThrow('does not exist');
        expect(searchActiveIncidents).not.toHaveBeenCalled();
        expect(showIncidents).not.toHaveBeenCalled();
    });
});

describe('Operate HTTP adapter', () => {
    test.each(['https://operate.example/proxy/cluster', 'https://operate.example/proxy/cluster/v1'])(
        'authenticates, carries all exact cursor values, and traverses short pages at %s', async (operateUrl) => {
            const { adapter, post } = mockAdapter();
            post.mockResolvedValueOnce({ data: '{"access_token":"dummy.token+/="}' })
                .mockResolvedValueOnce({ data: page() })
                .mockResolvedValueOnce({ data: page('9007199254741001') })
                .mockResolvedValueOnce({ data: empty });
            const results = await adapter.searchActiveIncidents({ ...connection, operateUrl, audience: ' original audience ' });
            expect(results).toEqual([sample, { ...sample, key: '9007199254741001' }]);
            const form = new URLSearchParams(post.mock.calls[0][1]);
            expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: connection.clientId,
                client_secret: connection.clientSecret, audience: ' original audience ' });
            expect(post.mock.calls[0][0]).toBe(connection.oAuthUrl);
            for (const call of post.mock.calls) {
                expect(call[2]).toMatchObject({ maxRedirects: 0, timeout: 30000, responseType: 'text' });
                expect(call[2].transformResponse[0]('9007199254740993')).toBe('9007199254740993');
            }
            for (const call of post.mock.calls.slice(1)) {
                expect(call[0]).toBe('https://operate.example/proxy/cluster/v1/incidents/search');
                expect(call[2].headers.Authorization).toBe('Bearer dummy.token+/=');
                expect(JSON.parse(call[1])).toMatchObject({ filter: { state: 'ACTIVE' }, size: 100, sort: [{ field: 'key', order: 'ASC' }] });
                expect(JSON.parse(call[1]).filter).toEqual({ state: 'ACTIVE' });
            }
            expect(JSON.parse(post.mock.calls[1][1])).not.toHaveProperty('searchAfter');
            expect(post.mock.calls[2][1]).toContain('"searchAfter":[9007199254740993,"tie-breaker",9007199254740999]');
            expect(post.mock.calls[3][1]).toContain('"searchAfter":[9007199254741001,"tie-breaker",9007199254740999]');
            expect(post).toHaveBeenCalledTimes(4);
        },
    );

    test('empty results and omitted Self-Managed audience', async () => {
        const { adapter, post } = mockAdapter();
        post.mockResolvedValueOnce({ data: '{"access_token":"dummy"}' }).mockResolvedValueOnce({ data: empty });
        expect(await adapter.searchActiveIncidents(connection)).toEqual([]);
        expect(new URLSearchParams(post.mock.calls[0][1]).has('audience')).toBe(false);
    });

    test.each(['{}', '{"access_token":""}', '{"access_token":"  "}', '{"access_token":"dummy\\r\\nsecret"}',
        '{"access_token":123}', '{"access_token":"Bearer dummy"}', 'not JSON dummy-secret'])(
        'rejects malformed authentication without issuing a search: %s', async (data) => {
            const { adapter, post } = mockAdapter();
            post.mockResolvedValueOnce({ data });
            await expect(adapter.searchActiveIncidents(connection)).rejects.toThrow(/OAuth authentication/);
            expect(post).toHaveBeenCalledTimes(1);
        },
    );

    test.each(['{}', '{"items":null}', '{"items":[null]}', 'not JSON dummy-secret',
        page().replace('"ACTIVE"', '"RESOLVED"'), page().replace('"ACTIVE"', '"PENDING"'),
        page().replace('"ACTIVE"', '"MIGRATED"'), page().replace('9007199254740995', '1.5'),
        page().replace('9007199254740995', '9223372036854775808'),
        page().replace('"JOB_NO_RETRIES"', 'null'), page().replace('"tenant"', 'null'),
    ])('rejects malformed incident response without publishing: %s', async (data) => {
        const { adapter, post } = mockAdapter();
        post.mockResolvedValueOnce({ data: '{"access_token":"dummy"}' }).mockResolvedValueOnce({ data });
        const showIncidents = jest.fn();
        const usecase = new ListIncidentsUseCase({ getProfile: () => profile }, adapter, { showIncidents });
        await expect(usecase.listIncidents({ profile: 'selected', json: true })).rejects.toThrow(/malformed/);
        expect(showIncidents).not.toHaveBeenCalled();
    });

    test.each(['null', '[]', '[9007199254740991]', '[9007199254740993,{}]'])(
        'rejects missing or incorrect cursors %s', async (cursor) => {
            const { adapter, post } = mockAdapter();
            post.mockResolvedValueOnce({ data: '{"access_token":"dummy"}' }).mockResolvedValueOnce({ data: page(undefined, cursor) });
            await expect(adapter.searchActiveIncidents(connection)).rejects.toThrow(/cursor/);
            expect(post).toHaveBeenCalledTimes(2);
        },
    );

    test.each([page(), page('9007199254740991'), page('9007199254741001', '[9007199254740993]')])(
        'rejects repeated/regressing pages or stalled later cursor', async (data) => {
            const { adapter, post } = mockAdapter();
            post.mockResolvedValueOnce({ data: '{"access_token":"dummy"}' })
                .mockResolvedValueOnce({ data: page() }).mockResolvedValueOnce({ data });
            await expect(adapter.searchActiveIncidents(connection)).rejects.toThrow(/progress/);
            expect(post).toHaveBeenCalledTimes(3);
        },
    );

    test.each([{ phase: 'auth', status: 401 }, { phase: 'search', status: 403 },
        { phase: 'later', status: 500 }, { phase: 'later', status: undefined }])(
        'sanitizes $phase failures (status $status) and publishes no partial data', async ({ phase, status }) => {
            const { adapter, post } = mockAdapter();
            if (phase !== 'auth') post.mockResolvedValueOnce({ data: '{"access_token":"dummy-token"}' });
            if (phase === 'later') post.mockResolvedValueOnce({ data: page() });
            post.mockRejectedValueOnce(Object.assign(new Error('dummy-secret dummy-token https://credential:password@host'), {
                isAxiosError: true, response: status ? { status, data: 'dummy-secret' } : undefined,
                config: { data: 'dummy-secret', headers: { Authorization: 'dummy-token' } },
            }));
            const output = jest.fn();
            const usecase = new ListIncidentsUseCase({ getProfile: () => profile }, adapter, new ConsoleIncidentsPresenter(output));
            try {
                await usecase.listIncidents({ profile: 'selected', json: true });
                throw new Error('Expected failure');
            } catch (error) {
                expect((error as Error).message).toMatch(/failed.*Check profile/);
                expect((error as Error).message).not.toMatch(/dummy-secret|dummy-token|password|credential:/);
                expect(error).not.toHaveProperty('cause');
                expect(error).not.toHaveProperty('config');
                expect(error).not.toHaveProperty('response');
                expect(error).not.toHaveProperty('data');
                if (status) expect((error as Error).message).toContain(`HTTP ${status}`);
            }
            expect(output).not.toHaveBeenCalled();
            expect(post).toHaveBeenCalledTimes(phase === 'auth' ? 1 : phase === 'search' ? 2 : 3);
        },
    );
});

describe('incident presentation and command', () => {
    test('writes one JSON array with exact keys and original messages; empty JSON is []', () => {
        const output = jest.fn();
        const presenter = new ConsoleIncidentsPresenter(output);
        presenter.showIncidents([sample], true);
        expect(output).toHaveBeenCalledTimes(1);
        expect(JSON.parse(output.mock.calls[0][0])).toEqual([sample]);
        output.mockClear();
        presenter.showIncidents([], true);
        expect(output.mock.calls).toEqual([['[]']]);
    });

    test('table preserves long messages but escapes controls, newline, ANSI and bidi sequences', () => {
        const output = jest.fn();
        const presenter = new ConsoleIncidentsPresenter(output);
        presenter.showIncidents([{ ...sample, message: sample.message + 'x'.repeat(500) }], false);
        const table = output.mock.calls[0][0] as string;
        expect(table).toContain('INCIDENT KEY');
        expect(table).toContain('PROCESS INSTANCE KEY');
        expect(table).toContain('JOB KEY');
        expect(table).toContain(sample.jobKey);
        expect(table).toContain('CREATION TIME');
        expect(table).toContain(sample.key);
        expect(table).toContain('\\u000a\\u001b[31merror\\u009b0m\\u202e!');
        expect(table).toContain('x'.repeat(500));
        for (const control of ['\u001b', '\u009b', '\u202e']) expect(table).not.toContain(control);
        expect(table.split('\n')).toHaveLength(2);
        output.mockClear();
        presenter.showIncidents([], false);
        expect(output.mock.calls[0][0]).toContain('MESSAGE');
    });

    test('missing job keys use a table placeholder but remain absent in JSON; job cells escape controls', () => {
        const nonJob = { ...sample };
        delete nonJob.jobKey;
        const output = jest.fn();
        const presenter = new ConsoleIncidentsPresenter(output);
        presenter.showIncidents([nonJob, { ...sample, jobKey: 'exact\u001b\u202e' }], false);
        const rows = (output.mock.calls[0][0] as string).split('\n');
        expect(rows[1].split(' | ')[2].trim()).toBe('-');
        expect(rows[2]).toContain('exact\\u001b\\u202e');
        presenter.showIncidents([nonJob], true);
        expect(JSON.parse(output.mock.calls[1][0])[0]).not.toHaveProperty('jobKey');
    });

    test('raw numeric jobKey above MAX_SAFE_INTEGER survives HTTP mapping and JSON presentation', async () => {
        const { adapter, post } = mockAdapter();
        post.mockResolvedValueOnce({ data: '{"access_token":"dummy"}' })
            .mockResolvedValueOnce({ data: page() }).mockResolvedValueOnce({ data: empty });
        const output = jest.fn();
        new ConsoleIncidentsPresenter(output).showIncidents(await adapter.searchActiveIncidents(connection), true);
        expect(JSON.parse(output.mock.calls[0][0])[0].jobKey).toBe('9007199254740999');
    });

    function command(listIncidentsInPort?: { listIncidents: jest.Mock }) {
        const cli = createCamundaCli({ downloadFilesInPort: { downloadFiles: jest.fn(), downloadFile: jest.fn() },
            sayHelloWorldInPort: { sayHelloWorld: jest.fn() }, listIncidentsInPort }).exitOverride()
            .configureOutput({ writeErr: () => undefined });
        cli.commands.forEach((child) => child.exitOverride().configureOutput({ writeErr: () => undefined }));
        return cli;
    }

    test('requires --profile through Commander and optional dependency only at invocation', async () => {
        const cli = command();
        await expect(cli.parseAsync(['incidents'], { from: 'user' })).rejects.toThrow('required option');
        await expect(cli.parseAsync(['incidents', '--profile', 'selected'], { from: 'user' })).rejects.toThrow('ListIncidentsInPort');
        await expect(command().parseAsync(['hello-world'], { from: 'user' })).resolves.toBeDefined();
    });

    test.each([false, true])('forwards explicit profile and JSON mode %s', async (json) => {
        const listIncidents = jest.fn();
        const cli = command({ listIncidents });
        await cli.parseAsync(['incidents', '--profile', 'selected', ...(json ? ['--json'] : [])], { from: 'user' });
        expect(listIncidents).toHaveBeenCalledWith({ profile: 'selected', ...(json ? { json: true } : {}) });
    });
});

describe('default incidents runtime', () => {
    let home: string;
    beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'camunda-incidents-')); });
    afterEach(async () => {
        jest.restoreAllMocks();
        await rm(home, { recursive: true, force: true });
    });

    async function store(profiles: Profile[]): Promise<void> {
        const directory = path.join(home, '.lmoesle-camunda-cli');
        await mkdir(directory);
        await writeFile(path.join(directory, 'profiles.json'), JSON.stringify({ profiles }));
    }

    test('uses the selected cached profile, never rereads modified disk, and writes clean JSON', async () => {
        await store([{ ...profile, name: 'other', operateUrl: 'https://other.example' }, profile]);
        const output = jest.fn();
        const diagnostic = jest.fn();
        const load = jest.spyOn(JsonProfileRepositoryAdapter.prototype, 'loadProfiles');
        const search = jest.spyOn(AxiosIncidentAdapter.prototype, 'searchActiveIncidents').mockResolvedValue([sample]);
        const cli = createDefaultCamundaCli({ homeDirectory: home, writeLine: output, writeDiagnostic: diagnostic });
        await cli.initialize();
        await writeFile(path.join(home, '.lmoesle-camunda-cli/profiles.json'), '{"profiles":[]}');
        await cli.parseAsync(['incidents', '--profile', ' selected ', '--json'], { from: 'user' });
        expect(search).toHaveBeenCalledWith({ ...connection, audience: undefined });
        expect(load).toHaveBeenCalledTimes(1);
        expect(output).toHaveBeenCalledTimes(1);
        expect(JSON.parse(output.mock.calls[0][0])).toEqual([sample]);
        expect(diagnostic).not.toHaveBeenCalled();
    });

    test.each(['runner', 'direct'])('routes missing-storage notices to diagnostics and no stdout on failure: %s', async (mode) => {
        const output = jest.fn();
        const diagnostic = jest.fn();
        const options = { homeDirectory: home, writeLine: output, writeDiagnostic: diagnostic };
        const args = ['incidents', '--profile', 'unknown', '--json'];
        const result = mode === 'runner' ? runDefaultCamundaCli(['node', 'cli', ...args], options) :
            createDefaultCamundaCli(options).parseAsync(args, { from: 'user' });
        await expect(result).rejects.toThrow('does not exist');
        expect(output).not.toHaveBeenCalled();
        expect(diagnostic.mock.calls).toEqual([['Please add a profile with the add profile command.']]);
    });

    test.each(['runner', 'direct'])('routes diagnostics before Commander rejects missing --profile: %s', async (mode) => {
        const originalParse = Command.prototype.parseAsync;
        jest.spyOn(Command.prototype, 'parseAsync').mockImplementation(function (this: Command, ...args) {
            this.commands.forEach((child) => child.exitOverride().configureOutput({ writeErr: () => undefined }));
            return originalParse.apply(this, args);
        });
        const output = jest.fn();
        const diagnostic = jest.fn();
        const options = { homeDirectory: home, writeLine: output, writeDiagnostic: diagnostic };
        const args = ['incidents', '--json'];
        await expect(mode === 'runner' ? runDefaultCamundaCli(['node', 'cli', ...args], options) :
            createDefaultCamundaCli(options).parseAsync(args, { from: 'user' })).rejects.toThrow('required option');
        expect(output).not.toHaveBeenCalled();
        // The runner has already loaded missing storage; direct parsing stops before startup.
        expect(diagnostic).toHaveBeenCalledTimes(mode === 'runner' ? 1 : 0);
    });

    test.each(['--help', '--version'])('runner preserves missing-storage notice before Commander exits for %s', async (flag) => {
        const originalParse = Command.prototype.parseAsync;
        jest.spyOn(Command.prototype, 'parseAsync').mockImplementation(function (this: Command, ...args) {
            this.exitOverride();
            return originalParse.apply(this, args);
        });
        jest.spyOn(process.stdout, 'write').mockReturnValue(true);
        const output = jest.fn();
        await expect(runDefaultCamundaCli(['node', 'cli', flag], { homeDirectory: home, writeLine: output }))
            .rejects.toMatchObject({ exitCode: 0 });
        expect(output.mock.calls).toEqual([['Please add a profile with the add profile command.']]);
    });

    test.each([' \t ', 'unknown'])('rejects profile name %j without network requests or stdout', async (name) => {
        await store([profile]);
        const search = jest.spyOn(AxiosIncidentAdapter.prototype, 'searchActiveIncidents');
        const output = jest.fn();
        const cli = createDefaultCamundaCli({ homeDirectory: home, writeLine: output });
        await expect(cli.parseAsync(['incidents', '--profile', name, '--json'], { from: 'user' })).rejects.toThrow();
        expect(search).not.toHaveBeenCalled();
        expect(output).not.toHaveBeenCalled();
    });

    test('runner emits only [] for an empty successful search and preserves other command notices', async () => {
        await store([profile]);
        jest.spyOn(AxiosIncidentAdapter.prototype, 'searchActiveIncidents').mockResolvedValue([]);
        const output = jest.fn();
        await runDefaultCamundaCli(['node', 'cli', 'incidents', '--profile', 'selected', '--json'], { homeDirectory: home, writeLine: output });
        expect(output.mock.calls).toEqual([['[]']]);
        await rm(path.join(home, '.lmoesle-camunda-cli'), { recursive: true });
        output.mockClear();
        await runDefaultCamundaCli(['node', 'cli', 'hello-world'], { homeDirectory: home, writeLine: output });
        expect(output.mock.calls).toEqual([['Please add a profile with the add profile command.'], ['Hello, World!']]);
    });

    test('runner and direct parsing keep startup and later HTTP failures off stdout', async () => {
        await store([profile]);
        const output = jest.fn();
        jest.spyOn(AxiosIncidentAdapter.prototype, 'searchActiveIncidents').mockRejectedValue(new Error('Safe search failure'));
        await expect(runDefaultCamundaCli(['node', 'cli', 'incidents', '--profile', 'selected', '--json'],
            { homeDirectory: home, writeLine: output })).rejects.toThrow('Safe search failure');
        await writeFile(path.join(home, '.lmoesle-camunda-cli/profiles.json'), 'invalid dummy-secret');
        const cli = createDefaultCamundaCli({ homeDirectory: home, writeLine: output });
        await expect(cli.parseAsync(['incidents', '--profile', 'selected', '--json'], { from: 'user' })).rejects.not.toThrow('dummy-secret');
        expect(output).not.toHaveBeenCalled();
    });
});

describe('real Axios transport (loopback only, dummy credentials)', () => {
    let server: Server;
    afterEach(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

    test('keeps int64 precision on actual response parsing and request serialization', async () => {
        const requests: { url: string; body: string; authorization?: string }[] = [];
        server = createServer(async (request, response) => {
            let body = '';
            for await (const chunk of request) body += chunk.toString();
            requests.push({ url: request.url!, body, authorization: request.headers.authorization });
            response.setHeader('Content-Type', 'application/json');
            response.end(request.url === '/token' ? '{"access_token":"dummy-token"}' : requests.length === 2 ? page() : empty);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const adapter = new AxiosIncidentAdapter(axios.create({ proxy: false }));
        expect(await adapter.searchActiveIncidents({ ...connection, oAuthUrl: `${root}/token`, operateUrl: `${root}/proxy/cluster` })).toEqual([sample]);
        expect(requests.map((request) => request.url)).toEqual(['/token', '/proxy/cluster/v1/incidents/search', '/proxy/cluster/v1/incidents/search']);
        expect(new URLSearchParams(requests[0].body).get('client_secret')).toBe(connection.clientSecret);
        expect(requests[2].body).toContain('[9007199254740993,"tie-breaker",9007199254740999]');
        expect(requests[1].authorization).toBe('Bearer dummy-token');
        expect(requests[2].authorization).toBe('Bearer dummy-token');
    });

    test('refuses OAuth redirects rather than forwarding credentials', async () => {
        const urls: string[] = [];
        server = createServer((request, response) => {
            urls.push(request.url!);
            response.writeHead(307, { Location: '/credential-target' });
            response.end('dummy-secret');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const adapter = new AxiosIncidentAdapter(axios.create({ proxy: false }));
        await expect(adapter.searchActiveIncidents({ ...connection, oAuthUrl: `${root}/token` })).rejects.toThrow('HTTP 307');
        expect(urls).toEqual(['/token']);
    });

    test('refuses Operate redirects rather than forwarding the bearer token', async () => {
        const urls: string[] = [];
        server = createServer((request, response) => {
            urls.push(request.url!);
            if (request.url === '/token') {
                response.setHeader('Content-Type', 'application/json');
                response.end('{"access_token":"dummy-token"}');
            } else {
                response.writeHead(307, { Location: '/token-target' });
                response.end('dummy-token');
            }
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const adapter = new AxiosIncidentAdapter(axios.create({ proxy: false }));
        await expect(adapter.searchActiveIncidents({ ...connection, oAuthUrl: `${root}/token`, operateUrl: root })).rejects.toThrow('HTTP 307');
        expect(urls).toEqual(['/token', '/v1/incidents/search']);
    });
});
