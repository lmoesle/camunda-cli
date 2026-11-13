import axios, { AxiosInstance } from 'axios';
import { Command } from 'commander';
import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    AddVariablesBatchFailure, AddVariablesUseCase, AxiosAddVariablesAdapter, ConsoleAddVariablesPresenter,
    createCamundaCli, createDefaultCamundaCli, JsonProfileRepositoryAdapter, Profile, runDefaultCamundaCli,
} from '../src';
import { parseVariables } from '../src/domain/variables';

const large = '9223372036854775807';
const command = { profile: ' selected ', processInstances: `[" 0001 ","${large}"]`, variables: '{}' };
const profile: Profile = { name: 'selected', baseUrl: 'http://localhost:8080/proxy/v2///', operateUrl: 'invalid', zeebeUrl: 'invalid' };
const oauth = { oAuthUrl: 'https://auth.example/token', clientId: ' dummy+client ', clientSecret: ' dummy&secret ', audience: ' audience ' };
const variables = `{"nested":[null,true,{"流程":${large}}],"isLosslessNumber":true,"value":"text","object":{"isLosslessNumber":true,"value":"123"}}`;

function state(selected: Profile | undefined = profile) {
    const getProfile = jest.fn((name: string) => name === 'selected' ? selected : undefined);
    const update = jest.fn<Promise<void>, [string, Record<string, unknown>]>().mockResolvedValue(undefined);
    const connect = jest.fn().mockResolvedValue({ update });
    const showUpdated = jest.fn();
    const showFailed = jest.fn();
    const showSummary = jest.fn();
    const presenter = { showUpdated, showFailed, showSummary };
    return { getProfile, update, connect, ...presenter,
        usecase: new AddVariablesUseCase({ getProfile }, { connect }, presenter) };
}

describe('add-variables validation and batch', () => {
    test.each(['', '[]', '{}', 'null', '"1"', '[1]', '["1",null]', '["1",{}]', '["1",true]', '["1","0"]',
        '["1","-1"]', '["1","+2"]', '["1","1.0"]', '["1","1e2"]', '["1","0x10"]', '["1",""]',
        '["1","9223372036854775808"]', '["1","0001"]', '["01"," 1 "]', '["1",]'])('rejects keys %s before any I/O', async (processInstances) => {
        const s = state();
        await expect(s.usecase.addVariables({ ...command, processInstances })).rejects.toThrow(/Process instance|process instance/);
        expect(s.getProfile).not.toHaveBeenCalled();
        expect(s.connect).not.toHaveBeenCalled();
        expect(s.update).not.toHaveBeenCalled();
    });
    test.each(['', 'file.json', '{var1:"secret"}', '{"secret":}', 'null', '[]', 'true', '123', '"secret"', '{"a":1,}'])('rejects variables %s before any I/O', async (input) => {
        const s = state();
        await expect(s.usecase.addVariables({ ...command, variables: input })).rejects.toThrow('inline JSON object');
        expect(s.getProfile).not.toHaveBeenCalled();
    });
    test.each([' ', 'Selected', 'unknown'])('requires exact explicit profile %j', async (selected) => {
        const s = state();
        await expect(s.usecase.addVariables({ ...command, profile: selected })).rejects.toThrow('profile');
        expect(s.connect).not.toHaveBeenCalled();
    });
    test.each([{ baseUrl: 'ftp://bad' }, { baseUrl: 'https://user:secret@host' }, { baseUrl: 'https://host?secret' },
        { clientId: 'only' }, { ...oauth, oAuthUrl: 'bad' }, { ...oauth, audience: '' },
        { ...oauth, baseUrl: 'https://cluster.zeebe.camunda.io', audience: undefined }])('validates profile/auth %j before connect', async (overrides) => {
        const s = state({ ...profile, ...overrides });
        await expect(s.usecase.addVariables(command)).rejects.toThrow('Profile');
        expect(s.connect).not.toHaveBeenCalled();
    });
    test('normalizes ordered keys, shares exact variables, connects once and summarizes success', async () => {
        const s = state();
        await s.usecase.addVariables({ ...command, variables });
        expect(s.getProfile).toHaveBeenCalledWith('selected');
        expect(s.connect.mock.calls).toEqual([[{ restUrl: 'http://localhost:8080/proxy/v2' }]]);
        expect(s.update.mock.calls.map(([key]) => key)).toEqual(['1', large]);
        expect(s.update.mock.calls[0][1]).toBe(s.update.mock.calls[1][1]);
        expect(s.showUpdated.mock.calls).toEqual([['1'], [large]]);
        expect(s.showSummary).toHaveBeenCalledWith(2, 0);
        expect(s.showFailed).not.toHaveBeenCalled();
    });
    test('waits for each mutation and presents success only after its response', async () => {
        const s = state();
        let finish!: () => void;
        s.update.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
        const pending = s.usecase.addVariables(command);
        await Promise.resolve();
        expect(s.update).toHaveBeenCalledTimes(1);
        expect(s.showUpdated).not.toHaveBeenCalled();
        finish();
        await pending;
        expect(s.update).toHaveBeenCalledTimes(2);
    });
    test.each([false, true])('continues after errors and throws completed counts (all fail=%s)', async (allFail) => {
        const s = state();
        if (allFail) s.update.mockRejectedValue(new Error('secret config token variables HTTP 500'));
        else s.update.mockRejectedValueOnce(new Error('secret config token variables HTTP 403'));
        const result = s.usecase.addVariables(command);
        await expect(result).rejects.toBeInstanceOf(AddVariablesBatchFailure);
        await expect(result).rejects.toMatchObject({ successCount: allFail ? 0 : 1, failedCount: allFail ? 2 : 1 });
        await expect(result).rejects.not.toHaveProperty('cause');
        expect(s.update.mock.calls.map(([key]) => key)).toEqual(['1', large]);
        expect(s.showSummary).toHaveBeenCalledWith(allFail ? 0 : 1, allFail ? 2 : 1);
        expect(s.showUpdated).toHaveBeenCalledTimes(allFail ? 0 : 1);
        expect(s.showFailed.mock.calls[0][0]).toMatch(/HTTP \d{3}.*uncertain.*Check cluster state.*No retry or rollback/);
        expect(s.showFailed.mock.calls.join(' ')).not.toMatch(/secret|config|token|variables/);
    });
    test('setup failure stops the whole batch', async () => {
        const s = state();
        s.connect.mockRejectedValue(new Error('OAuth authentication failed.'));
        await expect(s.usecase.addVariables(command)).rejects.toThrow('OAuth');
        expect(s.update).not.toHaveBeenCalled();
        expect(s.showSummary).not.toHaveBeenCalled();
    });
    test('presenter keeps diagnostics separate and makes no completion claim', () => {
        const output = jest.fn();
        const diagnostic = jest.fn();
        const presenter = new ConsoleAddVariablesPresenter(output, diagnostic);
        presenter.showUpdated(large);
        presenter.showFailed('safe failure');
        presenter.showSummary(1, 1);
        expect(output.mock.calls).toEqual([[`Updated variables for process instance ${large}.`], ['Variable updates completed: 1 succeeded, 1 failed.']]);
        expect(diagnostic.mock.calls).toEqual([['safe failure']]);
    });
});

function mockHttp() {
    const request = jest.fn().mockResolvedValue({ status: 204, data: '' });
    return { request, adapter: new AxiosAddVariablesAdapter({ request } as unknown as AxiosInstance) };
}

describe('add-variables HTTP adapter', () => {
    test('one OAuth for N sequential updates, fresh OAuth per invocation; exact lossless envelope', async () => {
        const { request, adapter } = mockHttp();
        for (const token of ['dummy.one', 'dummy.two']) {
            request.mockResolvedValueOnce({ status: 200, data: `{"access_token":"${token}"}` });
            const session = await adapter.connect({ restUrl: 'https://gateway.example/proxy/v2', oauth });
            for (const key of ['1', large]) await session.update(key, parseVariables(variables));
        }
        expect(request).toHaveBeenCalledTimes(6);
        expect(Object.fromEntries(new URLSearchParams(request.mock.calls[0][0].data))).toEqual({
            grant_type: 'client_credentials', client_id: oauth.clientId, client_secret: oauth.clientSecret, audience: oauth.audience,
        });
        for (const i of [1, 2, 4, 5]) {
            expect(request.mock.calls[i][0]).toMatchObject({ method: 'PUT',
                url: `https://gateway.example/proxy/v2/element-instances/${i === 1 || i === 4 ? '1' : large}/variables`,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer dummy.${i < 3 ? 'one' : 'two'}` },
                data: `{"variables":${variables},"local":true}` });
        }
        for (const [config] of request.mock.calls) expect(config).toMatchObject({ timeout: 30000, maxRedirects: 0, responseType: 'text' });
    });
    test.each([{ status: 200, data: '' }, { status: 202, data: '{}' }, { status: 204, data: 'secret' },
        { status: 204, data: ' ' }, { status: 204, data: {} }])('rejects unexpected response %j', async (response) => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValue(response);
        const result = (await adapter.connect({ restUrl: 'http://localhost/v2' })).update('1', {});
        await expect(result).rejects.toThrow('unexpected response');
        await expect(result).rejects.not.toThrow('secret');
    });
    test.each(['{}', 'null', 'secret', '{"access_token":""}', '{"access_token":"dummy\\r\\nsecret"}'])('auth failure %s prevents writes', async (data) => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValue({ status: 200, data });
        const result = adapter.connect({ restUrl: 'http://localhost/v2', oauth });
        await expect(result).rejects.toThrow('OAuth authentication');
        await expect(result).rejects.not.toThrow('secret');
        expect(request).toHaveBeenCalledTimes(1);
    });
    test.each([undefined, 401, 403, 307, 500])('sanitizes network/status %j without retries or causes', async (status) => {
        const { request, adapter } = mockHttp();
        const failure = Object.assign(new Error('secret token variables'), { isAxiosError: true, config: { secret: 'secret' }, response: { status, data: 'secret' } });
        request.mockRejectedValue(failure);
        const result = (await adapter.connect({ restUrl: 'http://localhost/v2' })).update('1', {});
        await expect(result).rejects.toThrow('Variable update failed');
        await expect(result).rejects.not.toThrow(/secret|token|variables/);
        await expect(result).rejects.not.toHaveProperty('cause');
        await expect(result).rejects.not.toHaveProperty('config');
        await expect(result).rejects.not.toHaveProperty('response');
        expect(request).toHaveBeenCalledTimes(1);
        request.mockClear();
        await expect(adapter.connect({ restUrl: 'http://localhost/v2', oauth })).rejects.toThrow('OAuth authentication failed');
        expect(request).toHaveBeenCalledTimes(1);
    });
    test('Self-Managed OAuth omits audience; later unauthenticated session never reuses token', async () => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValueOnce({ status: 200, data: '{"access_token":"dummy"}' });
        await adapter.connect({ restUrl: 'http://localhost/v2', oauth: { oAuthUrl: oauth.oAuthUrl, clientId: 'dummy', clientSecret: 'dummy' } });
        expect(new URLSearchParams(request.mock.calls[0][0].data).has('audience')).toBe(false);
        await (await adapter.connect({ restUrl: 'http://localhost/v2' })).update('1', {});
        expect(request.mock.calls[1][0].headers).not.toHaveProperty('Authorization');
    });
});

function overrideExits(cli: Command): void {
    cli.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    cli.commands.forEach(overrideExits);
}
const args = ['add-variables', '--profile', command.profile, '--process-instances', command.processInstances, '--variables', '{}'];

describe('add-variables CLI', () => {
    test.each(['--profile', '--process-instances', '--variables'])('requires %s and its string value', async (option) => {
        for (const omitValueOnly of [false, true]) {
            const action = jest.fn();
            const cli = createCamundaCli({ addVariablesInPort: { addVariables: action } });
            overrideExits(cli);
            const index = args.indexOf(option);
            const argv = args.filter((_arg, i) => i !== index + 1 && (omitValueOnly || i !== index));
            await expect(cli.parseAsync(argv, { from: 'user' })).rejects.toThrow(/required option|argument missing/);
            expect(action).not.toHaveBeenCalled();
        }
    });
    test('help is offline and dependency is checked only when invoked', async () => {
        const cli = createCamundaCli({});
        overrideExits(cli);
        await expect(cli.parseAsync(['add-variables', '--help'], { from: 'user' })).rejects.toMatchObject({ exitCode: 0 });
        await expect(cli.parseAsync(args, { from: 'user' })).rejects.toThrow('AddVariablesInPort');
    });
});

describe('add-variables loopback and runtime', () => {
    let server: Server;
    let root: string;
    let home: string;
    let calls: { url?: string; method?: string; body: string; headers: IncomingHttpHeaders }[];
    let redirect: boolean;
    let failFirst: boolean;
    beforeEach(async () => {
        home = await fs.mkdtemp(path.join(tmpdir(), 'cli-variables-'));
        calls = [];
        redirect = false;
        failFirst = false;
        server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                calls.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers });
                if (redirect) { res.writeHead(307, { Location: `${root}/must-not-follow` }); res.end('secret'); }
                else if (req.url === '/token') { res.writeHead(200); res.end('{"access_token":"dummy"}'); }
                else if (failFirst && req.url?.includes('/1/')) { res.writeHead(403); res.end('secret token variables'); }
                else { res.writeHead(204); res.end(); }
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.rm(home, { recursive: true, force: true });
        jest.restoreAllMocks();
    });
    test('cached profiles, fresh OAuth once per invocation and N exact ordered PUTs', async () => {
        await new JsonProfileRepositoryAdapter(home, home).addProfile({ ...profile, baseUrl: `${root}/proxy/cluster/v2///`, ...oauth, oAuthUrl: `${root}/token` });
        const output = jest.fn();
        const runtime = createDefaultCamundaCli({ homeDirectory: home, workingDirectory: home, writeLine: output });
        await runtime.initialize();
        await fs.writeFile(path.join(home, '.lmoesle-camunda-cli/profiles.json'), '{"profiles":[]}');
        for (let i = 0; i < 2; i++) await runtime.parseAsync(args, { from: 'user' });
        expect(calls.map((call) => call.url)).toEqual([0, 1].flatMap(() => ['/token', '/proxy/cluster/v2/element-instances/1/variables', `/proxy/cluster/v2/element-instances/${large}/variables`]));
        expect(calls[1]).toMatchObject({ method: 'PUT', headers: { authorization: 'Bearer dummy', 'content-type': 'application/json' }, body: '{"variables":{},"local":true}' });
        expect(output.mock.calls).toEqual([0, 1].flatMap(() => [[`Updated variables for process instance 1.`], [`Updated variables for process instance ${large}.`], ['Variable updates completed: 2 succeeded, 0 failed.']]));
    });
    test('real partial failure continues; redirect never follows or retries', async () => {
        failFirst = true;
        const s = state({ ...profile, baseUrl: root, noAuth: true });
        const usecase = new AddVariablesUseCase(s, new AxiosAddVariablesAdapter(), s);
        await expect(usecase.addVariables(command)).rejects.toMatchObject({ successCount: 1, failedCount: 1 });
        expect(calls).toHaveLength(2);
        expect(s.showUpdated.mock.calls).toEqual([[large]]);
        expect(s.showFailed.mock.calls.join(' ')).not.toMatch(/secret|token/);
        calls = [];
        redirect = true;
        await expect(usecase.addVariables(command)).rejects.toMatchObject({ successCount: 0, failedCount: 2 });
        expect(calls).toHaveLength(2);
        expect(calls.some((call) => call.url === '/must-not-follow')).toBe(false);
    });
    test('explicit noAuth ignores malformed retained OAuth and strips polluted Axios defaults', async () => {
        const oldHeaders = axios.defaults.headers.common;
        const oldAuth = axios.defaults.auth;
        const oldCredentials = axios.defaults.withCredentials;
        try {
            axios.defaults.headers.common = { ...oldHeaders, Authorization: 'Bearer secret', 'Proxy-Authorization': 'Basic secret', Cookie: 'secret' };
            axios.defaults.auth = { username: 'dummy', password: 'secret' };
            axios.defaults.withCredentials = true;
            const s = state({ ...profile, baseUrl: `${root}/prefix`, noAuth: true, oAuthUrl: 'malformed', clientId: '', clientSecret: '' });
            await new AddVariablesUseCase(s, new AxiosAddVariablesAdapter(), s).addVariables(command);
            expect(calls).toHaveLength(2);
            for (const call of calls) {
                expect(call.url).toMatch(/^\/prefix\/v2\/element-instances\//);
                expect(call.headers.authorization).toBeUndefined();
                expect(call.headers['proxy-authorization']).toBeUndefined();
                expect(call.headers.cookie).toBeUndefined();
            }
        } finally {
            axios.defaults.headers.common = oldHeaders;
            axios.defaults.auth = oldAuth;
            axios.defaults.withCredentials = oldCredentials;
        }
    });
    test.each(['runner', 'direct'])('startup notices use stderr (%s), even with missing flags', async (mode) => {
        const original = Command.prototype.parseAsync;
        jest.spyOn(Command.prototype, 'parseAsync').mockImplementation(function (this: Command, ...parameters) {
            overrideExits(this);
            return original.apply(this, parameters);
        });
        for (const argv of [args, ['add-variables']]) {
            const output = jest.fn();
            const diagnostic = jest.fn();
            const options = { homeDirectory: home, workingDirectory: home, writeLine: output, writeDiagnostic: diagnostic };
            await expect(mode === 'runner' ? runDefaultCamundaCli(['node', 'cli', ...argv], options) :
                createDefaultCamundaCli(options).parseAsync(argv, { from: 'user' })).rejects.toThrow(/does not exist|required option/);
            expect(output).not.toHaveBeenCalled();
            expect(diagnostic).toHaveBeenCalledTimes(mode === 'runner' || argv === args ? 1 : 0);
        }
        expect(calls).toHaveLength(0);
    });
});
