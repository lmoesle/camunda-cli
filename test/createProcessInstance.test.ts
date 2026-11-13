import { AxiosInstance } from 'axios';
import { Command } from 'commander';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    AxiosProcessInstanceAdapter, CreateProcessInstanceUseCase, createCamundaCli, createDefaultCamundaCli,
    JsonProfileRepositoryAdapter, Profile, processInstanceRequest, runDefaultCamundaCli,
} from '../src';

const command = { id: ' process/流程 ', version: ' -1 ', variables: '{}', profile: ' selected ' };
const profile: Profile = { name: 'selected', baseUrl: 'http://localhost:8080/proxy/v2///' };
const oauth = { oAuthUrl: 'https://auth.example/token', clientId: ' dummy+client ', clientSecret: ' dummy&secret ', audience: ' audience ' };
const large = '9223372036854775807';

function state(selected: Profile | undefined = profile) {
    const getProfile = jest.fn((name: string) => name === 'selected' ? selected : undefined);
    const create = jest.fn().mockResolvedValue(large);
    const connect = jest.fn().mockResolvedValue({ create });
    const showCreated = jest.fn();
    return { getProfile, create, connect, showCreated,
        usecase: new CreateProcessInstanceUseCase({ getProfile }, { connect }, { showCreated }) };
}

describe('creation validation and orchestration', () => {
    test.each(['1', ' 2147483647 ', '-1', '0001'])('accepts deployed version %s, preserves ID, trims profile', async (version) => {
        const s = state();
        await s.usecase.createProcessInstance({ ...command, version });
        expect(s.getProfile).toHaveBeenCalledWith('selected');
        expect(s.connect).toHaveBeenCalledWith({ restUrl: 'http://localhost:8080/proxy/v2' });
        expect(s.create).toHaveBeenCalledWith({ processDefinitionId: command.id, processDefinitionVersion: Number(version), variables: {} });
        expect(s.showCreated).toHaveBeenCalledWith(large);
    });
    test.each(['', ' ', '0', '-2', '+1', '1.0', '1e2', '0x10', '1x', 'tag', '2147483648'])('rejects version %j before profile lookup', async (version) => {
        const s = state();
        await expect(s.usecase.createProcessInstance({ ...command, version })).rejects.toThrow('version');
        expect(s.getProfile).not.toHaveBeenCalled();
    });
    test.each(['', ' \t '])('rejects blank ID %j before profile lookup', async (id) => {
        const s = state();
        await expect(s.usecase.createProcessInstance({ ...command, id })).rejects.toThrow('ID');
        expect(s.getProfile).not.toHaveBeenCalled();
    });
    test.each(['', '{"secret":', 'null', '[]', 'true', 'false', '123', '"secret"'])('rejects nonobject/invalid variables %j safely', async (variables) => {
        const s = state();
        const result = s.usecase.createProcessInstance({ ...command, variables });
        await expect(result).rejects.toThrow('inline JSON object');
        await expect(result).rejects.not.toThrow('secret');
        expect(s.getProfile).not.toHaveBeenCalled();
    });
    test.each([' ', 'Selected', 'unknown'])('rejects profile %j without authentication', async (selected) => {
        const s = state();
        await expect(s.usecase.createProcessInstance({ ...command, profile: selected })).rejects.toThrow('profile');
        expect(s.connect).not.toHaveBeenCalled();
    });
    test.each([{ baseUrl: 'ftp://bad' }, { baseUrl: 'https://user:secret@host' }, { clientId: 'only' },
        { ...oauth, oAuthUrl: 'bad' }, { ...oauth, audience: '' }])('reuses endpoint/auth validation %j', async (overrides) => {
        const s = state({ ...profile, ...overrides });
        await expect(s.usecase.createProcessInstance(command)).rejects.toThrow('Profile');
        expect(s.connect).not.toHaveBeenCalled();
    });
    test('awaits creation and never presents failures or untrusted error details', async () => {
        const s = state();
        let finish!: (key: string) => void;
        s.create.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
        const pending = s.usecase.createProcessInstance(command);
        await Promise.resolve();
        expect(s.showCreated).not.toHaveBeenCalled();
        finish(large);
        await pending;
        expect(s.showCreated).toHaveBeenCalledTimes(1);
        s.showCreated.mockClear();
        s.create.mockRejectedValue(new Error('secret'));
        const result = s.usecase.createProcessInstance(command);
        await expect(result).rejects.toThrow('Check cluster state before rerunning');
        await expect(result).rejects.not.toThrow('secret');
        await expect(result).rejects.not.toHaveProperty('cause');
        expect(s.showCreated).not.toHaveBeenCalled();
    });
});

function mockHttp() {
    const request = jest.fn().mockResolvedValue({ status: 200, data: `{"processInstanceKey":${large}}` });
    return { request, adapter: new AxiosProcessInstanceAdapter({ request } as unknown as AxiosInstance) };
}

describe('creation HTTP session', () => {
    test('fresh OAuth each invocation, exact body with lossless nested variables and collision properties', async () => {
        const { request, adapter } = mockHttp();
        const variables = `{"nested":[null,true,{"流程":${large}}],"isLosslessNumber":true,"value":"text","processDefinitionId":"not-envelope"}`;
        for (const token of ['dummy.one', 'dummy.two']) {
            request.mockResolvedValueOnce({ status: 200, data: `{"access_token":"${token}"}` });
            const session = await adapter.connect({ restUrl: 'https://gateway.example/proxy/v2', oauth });
            expect(await session.create(processInstanceRequest('123', '-1', variables))).toBe(large);
        }
        expect(request).toHaveBeenCalledTimes(4);
        expect(Object.fromEntries(new URLSearchParams(request.mock.calls[0][0].data))).toEqual({
            grant_type: 'client_credentials', client_id: oauth.clientId, client_secret: oauth.clientSecret, audience: oauth.audience,
        });
        for (const i of [1, 3]) {
            expect(request.mock.calls[i][0]).toMatchObject({ method: 'POST', url: 'https://gateway.example/proxy/v2/process-instances',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer dummy.${i === 1 ? 'one' : 'two'}` },
                data: `{"processDefinitionId":"123","processDefinitionVersion":-1,"variables":${variables}}` });
        }
        for (const [config] of request.mock.calls) expect(config).toMatchObject({ timeout: 30000, maxRedirects: 0, responseType: 'text' });
    });
    test.each([`{"processInstanceKey":"${large}"}`, `{"processInstanceKey":${large}}`, '{"processInstanceKey":"1"}'])('accepts exact key from %s', async (data) => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValue({ status: 200, data });
        expect(await (await adapter.connect({ restUrl: 'http://localhost/v2' })).create(processInstanceRequest('p', '1', '{}')))
            .toBe(data.includes(large) ? large : '1');
    });
    test.each(['secret', 'null', '[]', '{}', '{"processInstanceKey":0}', '{"processInstanceKey":-1}',
        '{"processInstanceKey":"9223372036854775808"}', '{"processInstanceKey":1.5}', '{"processInstanceKey":"secret"}',
        '{"processInstanceKey":{"isLosslessNumber":true,"value":"1"}}'])('rejects malformed response %s without false success', async (data) => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValue({ status: 200, data });
        const s = state();
        const usecase = new CreateProcessInstanceUseCase(s, adapter, s);
        const result = usecase.createProcessInstance(command);
        await expect(result).rejects.toThrow(/malformed.*Check cluster state/);
        await expect(result).rejects.not.toThrow('secret');
        expect(request).toHaveBeenCalledTimes(1);
        expect(s.showCreated).not.toHaveBeenCalled();
    });
    test.each([201, 202, 204])('rejects unexpected successful HTTP %s', async (status) => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValue({ status, data: '{"processInstanceKey":"1"}' });
        await expect((await adapter.connect({ restUrl: 'http://localhost/v2' })).create(processInstanceRequest('p', '1', '{}')))
            .rejects.toThrow('unexpected HTTP status');
    });
    test.each(['{}', 'null', 'secret', '{"access_token":""}', '{"access_token":"dummy\\r\\nsecret"}'])('auth failure %s prevents creation', async (data) => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValue({ status: 200, data });
        await expect(adapter.connect({ restUrl: 'http://localhost/v2', oauth })).rejects.toThrow('OAuth authentication');
        expect(request).toHaveBeenCalledTimes(1);
    });
    test.each([401, 403, 500])('OAuth HTTP %s stops before creation and leaks no credentials', async (status) => {
        const { request, adapter } = mockHttp();
        request.mockRejectedValue(Object.assign(new Error('secret-token'), { isAxiosError: true, response: { status, data: 'secret' } }));
        const s = state({ ...profile, ...oauth });
        const result = new CreateProcessInstanceUseCase(s, adapter, s).createProcessInstance(command);
        await expect(result).rejects.toThrow(`OAuth authentication failed (HTTP ${status})`);
        await expect(result).rejects.not.toThrow('secret');
        await expect(result).rejects.not.toHaveProperty('cause');
        expect(request).toHaveBeenCalledTimes(1);
        expect(s.showCreated).not.toHaveBeenCalled();
    });
    test('Self-Managed OAuth can omit audience; no-auth session never reuses a token', async () => {
        const { request, adapter } = mockHttp();
        request.mockResolvedValueOnce({ status: 200, data: '{"access_token":"dummy"}' });
        const withoutAudience = { oAuthUrl: oauth.oAuthUrl, clientId: oauth.clientId, clientSecret: oauth.clientSecret };
        await adapter.connect({ restUrl: 'http://localhost/v2', oauth: withoutAudience });
        expect(new URLSearchParams(request.mock.calls[0][0].data).has('audience')).toBe(false);
        const session = await adapter.connect({ restUrl: 'http://localhost/v2' });
        await session.create(processInstanceRequest('p', '1', '{}'));
        expect(request.mock.calls[1][0].headers).not.toHaveProperty('Authorization');
        expect(request).toHaveBeenCalledTimes(2);
    });
    test.each([undefined, 401, 403, 307, 500])('sanitizes network/HTTP %j without retries', async (status) => {
        const { request, adapter } = mockHttp();
        request.mockRejectedValue(Object.assign(new Error('secret-token variables'), { isAxiosError: true, response: { status, data: 'secret' } }));
        const s = state();
        const result = new CreateProcessInstanceUseCase(s, adapter, s).createProcessInstance(command);
        await expect(result).rejects.toThrow('Check cluster state before rerunning');
        await expect(result).rejects.not.toThrow(/secret|variables/);
        await expect(result).rejects.not.toHaveProperty('cause');
        await expect(result).rejects.not.toHaveProperty('response');
        expect(request).toHaveBeenCalledTimes(1);
        expect(s.showCreated).not.toHaveBeenCalled();
    });
});

function overrideExits(cli: Command): void {
    cli.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    cli.commands.forEach(overrideExits);
}
const args = ['create-process-instance', '--id', command.id, '--version', '-1', '--variables', '{}', '--profile', command.profile];

describe('creation CLI', () => {
    test.each(['--id', '--version', '--variables', '--profile'])('requires %s and its value', async (option) => {
        for (const omitValueOnly of [false, true]) {
            const action = jest.fn();
            const cli = createCamundaCli({ createProcessInstanceInPort: { createProcessInstance: action } });
            overrideExits(cli);
            const index = args.indexOf(option);
            const argv = args.filter((_arg, i) => i !== index + 1 && (omitValueOnly || i !== index));
            await expect(cli.parseAsync(argv, { from: 'user' })).rejects.toThrow(/required option|argument missing/);
            expect(action).not.toHaveBeenCalled();
        }
    });
    test('child version is a string option; root version still prints CLI version; help needs no dependency', async () => {
        const action = jest.fn();
        const cli = createCamundaCli({ version: '9.8.7', createProcessInstanceInPort: { createProcessInstance: action } });
        overrideExits(cli);
        await cli.parseAsync(args, { from: 'user' });
        expect(action).toHaveBeenCalledWith({ ...command, version: '-1' });
        for (const flag of ['--version', '-V']) {
            const root = createCamundaCli({ version: '9.8.7' });
            overrideExits(root);
            const output = jest.fn();
            root.configureOutput({ writeOut: output });
            await expect(root.parseAsync([flag], { from: 'user' })).rejects.toMatchObject({ exitCode: 0 });
            expect(output).toHaveBeenCalledWith('9.8.7\n');
        }
        const optional = createCamundaCli({});
        overrideExits(optional);
        await expect(optional.parseAsync(['create-process-instance', '--help'], { from: 'user' })).rejects.toMatchObject({ exitCode: 0 });
        await expect(optional.parseAsync(args, { from: 'user' })).rejects.toThrow('CreateProcessInstanceInPort');
    });
});

describe('creation loopback and default runtime', () => {
    let server: Server;
    let root: string;
    let home: string;
    let calls: { url?: string; method?: string; body: string; auth?: string; type?: string }[];
    let redirect: boolean;
    beforeEach(async () => {
        home = await fs.mkdtemp(path.join(tmpdir(), 'cli-create-'));
        calls = [];
        redirect = false;
        server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                calls.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString(), auth: req.headers.authorization, type: req.headers['content-type'] });
                if (redirect) { res.writeHead(307, { Location: `${root}/must-not-follow` }); res.end(); }
                else { res.writeHead(200); res.end(req.url === '/token' ? '{"access_token":"dummy"}' : `{"processInstanceKey":${large}}`); }
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
    test('cached selected profile sends one exact creation and fresh OAuth per invocation', async () => {
        await new JsonProfileRepositoryAdapter(home, home).addProfile({ ...profile, baseUrl: `${root}/proxy/cluster/v2///`, ...oauth, oAuthUrl: `${root}/token` });
        const output = jest.fn();
        const runtime = createDefaultCamundaCli({ homeDirectory: home, workingDirectory: home, writeLine: output });
        await runtime.initialize();
        await fs.writeFile(path.join(home, '.lmoesle-camunda-cli/profiles.json'), '{"profiles":[]}');
        for (let i = 0; i < 2; i++) await runtime.parseAsync(args, { from: 'user' });
        expect(calls.map((call) => call.url)).toEqual(['/token', '/proxy/cluster/v2/process-instances', '/token', '/proxy/cluster/v2/process-instances']);
        expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({ grant_type: 'client_credentials', client_id: oauth.clientId, client_secret: oauth.clientSecret, audience: oauth.audience });
        expect(calls[1]).toEqual({ url: '/proxy/cluster/v2/process-instances', method: 'POST', auth: 'Bearer dummy', type: 'application/json',
            body: JSON.stringify({ processDefinitionId: command.id, processDefinitionVersion: -1, variables: {} }) });
        expect(output.mock.calls).toEqual([[`Created process instance ${large}.`], [`Created process instance ${large}.`]]);
    });
    test('mutation redirects are not followed or retried', async () => {
        redirect = true;
        const s = state({ ...profile, baseUrl: root, noAuth: true });
        await expect(new CreateProcessInstanceUseCase(s, new AxiosProcessInstanceAdapter(), s).createProcessInstance(command))
            .rejects.toThrow(/HTTP 307.*Check cluster state/);
        expect(calls).toHaveLength(1);
        expect(s.showCreated).not.toHaveBeenCalled();
    });
    test.each(['runner', 'direct'])('routes startup notices to stderr for %s, including missing flags', async (mode) => {
        const original = Command.prototype.parseAsync;
        jest.spyOn(Command.prototype, 'parseAsync').mockImplementation(function (this: Command, ...parameters) {
            overrideExits(this);
            return original.apply(this, parameters);
        });
        for (const argv of [args, ['create-process-instance']]) {
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
