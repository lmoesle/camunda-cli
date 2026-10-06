import { AxiosInstance } from 'axios';
import { Command } from 'commander';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    AxiosIncidentRetryAdapter, ConsoleIncidentRetryPresenter, createCamundaCli, createDefaultCamundaCli,
    IncidentRetryFailure, JsonProfileRepositoryAdapter, Profile, RestConnection, RetryIncidentUseCase, runDefaultCamundaCli,
} from '../src';

const local: Profile = { name: 'selected', baseUrl: 'http://localhost:8080/proxy/cluster/' };
const oauth = { oAuthUrl: 'https://auth.example/token', clientId: ' dummy+client ', clientSecret: ' dummy+secret&= / ' };
const command = { profile: 'selected', incident: '9007199254740993', job: '9223372036854775807' };
const connection: RestConnection = { restUrl: 'https://gateway.example/proxy/v2', oauth };

function orchestration(profile: Profile | undefined = local) {
    const resetJobRetries = jest.fn().mockResolvedValue(undefined);
    const resolveIncident = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockResolvedValue({ resetJobRetries, resolveIncident });
    const showRetryRequested = jest.fn();
    const getProfile = jest.fn((name: string) => name === 'selected' ? profile : undefined);
    return { resetJobRetries, resolveIncident, connect, showRetryRequested, getProfile,
        usecase: new RetryIncidentUseCase({ getProfile }, { connect }, { showRetryRequested }) };
}

function mockHttp() {
    const request = jest.fn().mockResolvedValue({ data: '', status: 204 });
    return { request, adapter: new AxiosIncidentRetryAdapter({ request } as unknown as AxiosInstance) };
}

describe('retry validation and orchestration', () => {
    test.each(['http://localhost:8080/proxy/cluster/', 'http://localhost:8080/proxy/cluster/v2///'])(
        'preserves prefix at %s and normalizes only URLs/name/keys', async (baseUrl) => {
            const state = orchestration({ ...local, baseUrl, ...oauth, oAuthUrl: ' https://auth.example/token/ ', audience: ' audience bytes ' });
            await state.usecase.retryIncident({ profile: ' selected ', incident: ' \t0001 ', job: ' 009223372036854775807 ' });
            expect(state.getProfile).toHaveBeenCalledWith('selected');
            expect(state.connect).toHaveBeenCalledWith({ restUrl: 'http://localhost:8080/proxy/cluster/v2',
                oauth: { ...oauth, audience: ' audience bytes ' } });
            expect(state.resetJobRetries).toHaveBeenCalledWith('9223372036854775807');
            expect(state.resolveIncident).toHaveBeenCalledWith('1');
            expect(state.showRetryRequested).toHaveBeenCalledWith('1', '9223372036854775807');
        },
    );

    test.each(['', ' ', '0', '000', '-1', '+1', '1.0', '1.5', '1e3', '0x10', '1/../2', '1\n2',
        '9223372036854775808', 'unsafe\u001bsecret'])(
        'rejects either invalid key %j before authentication or mutation', async (value) => {
            for (const field of ['incident', 'job']) {
                const state = orchestration();
                await expect(state.usecase.retryIncident({ ...command, [field]: value })).rejects.toThrow(/key/);
                expect(state.getProfile).not.toHaveBeenCalled();
                expect(state.connect).not.toHaveBeenCalled();
                expect(state.resetJobRetries).not.toHaveBeenCalled();
                expect(state.showRetryRequested).not.toHaveBeenCalled();
                await expect(state.usecase.retryIncident({ ...command, [field]: value })).rejects.not.toThrow('unsafe');
            }
        },
    );

    test.each([' ', 'Selected', 'unknown'])('rejects blank or unknown case-sensitive profile %j', async (profile) => {
        const state = orchestration();
        await expect(state.usecase.retryIncident({ ...command, profile })).rejects.toThrow(/profile/);
        expect(state.connect).not.toHaveBeenCalled();
    });

    test.each([
        { baseUrl: undefined }, { baseUrl: '' }, { baseUrl: 'bad' }, { baseUrl: 'ftp://host' },
        { baseUrl: 'https://dummy:secret@host' }, { baseUrl: 'https://host?secret' }, { baseUrl: 'https://host#secret' },
        { baseUrl: 'https://host?' }, { baseUrl: 'https://host#' }, { clientId: 'only' }, { clientSecret: 'only' },
        { oAuthUrl: 'https://auth.example' }, { audience: 'only' }, { ...oauth, clientId: '' },
        { ...oauth, clientSecret: ' \t ' }, { ...oauth, oAuthUrl: ' ' }, { ...oauth, oAuthUrl: 'https://user:secret@host' },
        { ...oauth, oAuthUrl: 'https://host?' }, { ...oauth, oAuthUrl: 'https://host#' },
        { ...oauth, audience: '' }, { ...oauth, audience: undefined },
        { ...oauth, baseUrl: 'https://bru-1.zeebe.camunda.io/cluster' },
        { ...oauth, oAuthUrl: 'https://login.cloud.camunda.io/oauth/token' },
    ])('rejects invalid profile %j before connect', async (overrides) => {
        const state = orchestration({ ...local, ...overrides } as Profile);
        await expect(state.usecase.retryIncident(command)).rejects.toThrow(/Profile/);
        expect(state.connect).not.toHaveBeenCalled();
        expect(state.showRetryRequested).not.toHaveBeenCalled();
    });

    test('awaits reset before resolving and presents only after both operations', async () => {
        const state = orchestration();
        let acceptReset!: () => void;
        const reset = new Promise<void>((resolve) => { acceptReset = resolve; });
        state.resetJobRetries.mockReturnValue(reset);
        const result = state.usecase.retryIncident(command);
        await Promise.resolve();
        expect(state.resetJobRetries).toHaveBeenCalledWith(command.job);
        expect(state.resolveIncident).not.toHaveBeenCalled();
        expect(state.showRetryRequested).not.toHaveBeenCalled();
        acceptReset();
        await result;
        expect(state.resolveIncident).toHaveBeenCalledWith(command.incident);
        expect(state.showRetryRequested).toHaveBeenCalledTimes(1);
        expect(state.connect).toHaveBeenCalledWith({ restUrl: 'http://localhost:8080/proxy/cluster/v2' });
    });

    test.each(['auth', 'reset', 'resolution'])('stops and emits no false success on %s failure', async (phase) => {
        const state = orchestration();
        const failure = new IncidentRetryFailure('Safe failure (HTTP 403).');
        if (phase === 'auth') state.connect.mockRejectedValue(failure);
        if (phase === 'reset') state.resetJobRetries.mockRejectedValue(failure);
        if (phase === 'resolution') state.resolveIncident.mockRejectedValue(failure);
        await expect(state.usecase.retryIncident(command)).rejects.toThrow(phase === 'resolution'
            ? /HTTP 403.*already been updated.*no rollback.*uncertain.*Check state/ : /HTTP 403/);
        expect(state.showRetryRequested).not.toHaveBeenCalled();
        if (phase !== 'resolution') expect(state.resolveIncident).not.toHaveBeenCalled();
        if (phase === 'auth') expect(state.resetJobRetries).not.toHaveBeenCalled();
    });

    test('does not echo an untrusted resolution error', async () => {
        const state = orchestration();
        state.resolveIncident.mockRejectedValue(new Error('secret-token'));
        await expect(state.usecase.retryIncident(command)).rejects.not.toThrow('secret-token');
    });
});

describe('retry HTTP session', () => {
    test('one fresh token per invocation, exact credentials, PATCH body, and bodyless POST; no token in no-auth session', async () => {
        const { adapter, request } = mockHttp();
        request.mockResolvedValueOnce({ data: '{"access_token":"dummy.token+/="}' });
        const session = await adapter.connect({ ...connection, oauth: { ...oauth, audience: ' original audience ' } });
        await session.resetJobRetries(command.job);
        await session.resolveIncident(command.incident);
        expect(Object.fromEntries(new URLSearchParams(request.mock.calls[0][0].data))).toEqual({
            grant_type: 'client_credentials', client_id: oauth.clientId, client_secret: oauth.clientSecret, audience: ' original audience ',
        });
        expect(request.mock.calls[1][0]).toMatchObject({ method: 'PATCH', url: `${connection.restUrl}/jobs/${command.job}`,
            data: { changeset: { retries: 3 } }, headers: { Authorization: 'Bearer dummy.token+/=' } });
        expect(request.mock.calls[2][0]).toMatchObject({ method: 'POST', url: `${connection.restUrl}/incidents/${command.incident}/resolution`,
            headers: { Authorization: 'Bearer dummy.token+/=' } });
        expect(request.mock.calls[2][0]).not.toHaveProperty('data');
        expect(request.mock.calls[2][0].headers).toMatchObject({ 'Content-Type': 'application/json' });
        const noAuth = await adapter.connect({ restUrl: connection.restUrl });
        await noAuth.resetJobRetries('1');
        await noAuth.resolveIncident('2');
        expect(request.mock.calls[3][0].headers).not.toHaveProperty('Authorization');
        expect(request.mock.calls[4][0].headers).not.toHaveProperty('Authorization');
        expect(request.mock.calls[4][0].headers).toMatchObject({ 'Content-Type': 'application/json' });
        expect(request.mock.calls[4][0]).not.toHaveProperty('data');
        request.mockResolvedValueOnce({ data: '{"access_token":"fresh"}' });
        const fresh = await adapter.connect(connection);
        await fresh.resetJobRetries('3');
        expect(request.mock.calls[6][0].headers.Authorization).toBe('Bearer fresh');
        expect(new URLSearchParams(request.mock.calls[5][0].data).has('audience')).toBe(false);
        expect(request).toHaveBeenCalledTimes(7);
        for (const [config] of request.mock.calls) expect(config).toMatchObject({ timeout: 30000, maxRedirects: 0, responseType: 'text' });
    });

    test.each(['{}', 'null', '[]', '{"access_token":""}', '{"access_token":12}', '{"access_token":"dummy\\r\\nsecret"}', 'dummy-secret'])(
        'rejects unsafe/malformed token %s before mutation', async (data) => {
            const { adapter, request } = mockHttp();
            request.mockResolvedValueOnce({ data });
            await expect(adapter.connect(connection)).rejects.toThrow(/OAuth authentication/);
            expect(request).toHaveBeenCalledTimes(1);
        },
    );

    test.each([undefined, 401, 403, 302, 500])('sanitizes each phase HTTP/network %j without retrying', async (status) => {
        for (const phase of ['auth', 'reset', 'resolution']) {
            const { adapter, request } = mockHttp();
            if (phase !== 'auth') request.mockResolvedValueOnce({ data: '{"access_token":"dummy"}' });
            if (phase === 'resolution') request.mockResolvedValueOnce({ data: '' });
            request.mockRejectedValue(Object.assign(new Error('dummy-secret dummy-token https://unsafe.example'), {
                isAxiosError: true, response: status ? { status, data: 'dummy-secret' } : undefined,
            }));
            const output = jest.fn();
            const usecase = new RetryIncidentUseCase({ getProfile: () => ({ ...local, ...oauth }) }, adapter, { showRetryRequested: output });
            const result = usecase.retryIncident(command);
            await expect(result).rejects.toThrow(status ? `HTTP ${status}` : /failed/);
            await expect(result).rejects.not.toThrow(/dummy-secret|dummy-token|unsafe.example/);
            expect(request).toHaveBeenCalledTimes(phase === 'auth' ? 1 : phase === 'reset' ? 2 : 3);
            expect(output).not.toHaveBeenCalled();
        }
    });
});

function overrideExits(cli: Command): void {
    cli.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    cli.commands.forEach(overrideExits);
}

describe('retry CLI', () => {
    function cli(retryIncident?: jest.Mock) {
        const result = createCamundaCli({ downloadFilesInPort: { downloadFiles: jest.fn(), downloadFile: jest.fn() },
            sayHelloWorldInPort: { sayHelloWorld: jest.fn() }, retryIncidentInPort: retryIncident ? { retryIncident } : undefined });
        overrideExits(result);
        return result;
    }
    const args = ['incident', 'retry', '--incident', command.incident, '--job', command.job, '--profile', 'selected'];

    test.each(['--incident', '--job', '--profile'])('requires %s before invoking usecase', async (option) => {
        const retry = jest.fn();
        const index = args.indexOf(option);
        await expect(cli(retry).parseAsync(args.filter((_arg, i) => i !== index && i !== index + 1), { from: 'user' }))
            .rejects.toThrow('required option');
        expect(retry).not.toHaveBeenCalled();
    });
    test('forwards options losslessly and keeps dependency optional for existing commands', async () => {
        const retry = jest.fn();
        await cli(retry).parseAsync(args, { from: 'user' });
        expect(retry).toHaveBeenCalledWith(command);
        await expect(cli().parseAsync(['hello-world'], { from: 'user' })).resolves.toBeDefined();
        await expect(cli().parseAsync(args, { from: 'user' })).rejects.toThrow('RetryIncidentInPort');
        await expect(cli().parseAsync(['incident', 'retry', '--help'], { from: 'user' })).rejects.toMatchObject({ exitCode: 0 });
    });
});

describe('loopback wire and cached default runtime', () => {
    let server: Server;
    let root: string;
    let home: string;
    let requests: { method?: string; url?: string; body: string; authorization?: string; contentType?: string }[];
    let redirect: boolean;
    beforeEach(async () => {
        home = await fs.mkdtemp(path.join(tmpdir(), 'cli-retry-'));
        requests = [];
        redirect = false;
        server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString(),
                    authorization: req.headers.authorization, contentType: req.headers['content-type'] });
                if (redirect) { res.writeHead(307, { Location: `${root}/must-not-follow` }); res.end(); }
                else if (req.url === '/token') { res.writeHead(200); res.end('{"access_token":"dummy"}'); }
                else if (req.url?.endsWith('/resolution') && req.headers['content-type'] !== 'application/json') {
                    res.writeHead(415); res.end();
                }
                else if (req.url?.endsWith('/resolution') && Buffer.concat(chunks).length !== 0) {
                    res.writeHead(400); res.end();
                }
                else { res.writeHead(204); res.end(); }
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await fs.rm(home, { recursive: true, force: true });
    });
    test('cached runtime sends exact OAuth/PATCH/bodyless POST requests and accepts empty 204', async () => {
        const repository = new JsonProfileRepositoryAdapter(home);
        await repository.addProfile({ ...local, baseUrl: `${root}/proxy/cluster/v2///`, ...oauth, oAuthUrl: `${root}/token` });
        const load = jest.spyOn(JsonProfileRepositoryAdapter.prototype, 'loadProfiles');
        const output = jest.fn();
        const runtime = createDefaultCamundaCli({ homeDirectory: home, writeLine: output });
        await runtime.initialize();
        await fs.writeFile(path.join(home, '.lmoesle-camunda-cli/profiles.json'), '{"profiles":[]}');
        await runtime.parseAsync(['incident', 'retry', '--incident', command.incident, '--job', command.job,
            '--profile', ' selected '], { from: 'user' });
        expect(load).toHaveBeenCalledTimes(1);
        expect(requests).toHaveLength(3);
        expect(requests[0]).toMatchObject({ method: 'POST', url: '/token', contentType: 'application/x-www-form-urlencoded' });
        expect(Object.fromEntries(new URLSearchParams(requests[0].body))).toEqual({ grant_type: 'client_credentials',
            client_id: oauth.clientId, client_secret: oauth.clientSecret });
        expect(requests[1]).toMatchObject({ method: 'PATCH', url: `/proxy/cluster/v2/jobs/${command.job}`,
            authorization: 'Bearer dummy', contentType: 'application/json' });
        expect(requests[1].body).toBe('{"changeset":{"retries":3}}');
        expect(requests[2]).toMatchObject({ method: 'POST', url: `/proxy/cluster/v2/incidents/${command.incident}/resolution`,
            authorization: 'Bearer dummy', contentType: 'application/json', body: '' });
        expect(output).toHaveBeenCalledTimes(1);
        expect(output.mock.calls[0][0]).toMatch(/^Retry requested.*resolution accepted/);
    });
    test('no-auth resolution sends JSON media type with zero bytes after the exact JSON PATCH', async () => {
        const output = jest.fn();
        const usecase = new RetryIncidentUseCase({ getProfile: () => ({ ...local, baseUrl: `${root}/proxy/cluster` }) },
            new AxiosIncidentRetryAdapter(), new ConsoleIncidentRetryPresenter(output));
        // Capture rejection so a RED run also exposes Axios's actual on-wire media type.
        const result = await usecase.retryIncident(command).catch((error: unknown) => error);
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({ method: 'PATCH', url: `/proxy/cluster/v2/jobs/${command.job}`,
            authorization: undefined, contentType: 'application/json', body: '{"changeset":{"retries":3}}' });
        expect(requests[1]).toMatchObject({ method: 'POST', url: `/proxy/cluster/v2/incidents/${command.incident}/resolution`,
            authorization: undefined, body: '' });
        expect(requests[1].contentType).toBe('application/json');
        expect(result).toBeUndefined();
        expect(output).toHaveBeenCalledTimes(1);
        expect(output.mock.calls[0][0]).toMatch(/^Retry requested.*resolution accepted/);
    });
    test('does not follow a mutation redirect or send resolution', async () => {
        redirect = true;
        const output = jest.fn();
        const usecase = new RetryIncidentUseCase({ getProfile: () => ({ ...local, baseUrl: root }) },
            new AxiosIncidentRetryAdapter(), new ConsoleIncidentRetryPresenter(output));
        await expect(usecase.retryIncident(command)).rejects.toThrow('HTTP 307');
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: 'PATCH', url: `/v2/jobs/${command.job}`, authorization: undefined });
        expect(output).not.toHaveBeenCalled();
    });
    test.each(['runner', 'direct'])('nested command keeps startup notices on stderr: %s', async (mode) => {
        const output = jest.fn();
        const diagnostic = jest.fn();
        const options = { homeDirectory: home, writeLine: output, writeDiagnostic: diagnostic };
        const args = ['incident', 'retry', '--incident', '1', '--job', '2', '--profile', 'unknown'];
        await expect(mode === 'runner' ? runDefaultCamundaCli(['node', 'cli', ...args], options) :
            createDefaultCamundaCli(options).parseAsync(args, { from: 'user' })).rejects.toThrow('does not exist');
        expect(output).not.toHaveBeenCalled();
        expect(diagnostic.mock.calls).toEqual([['Please add a profile with the add profile command.']]);
        expect(requests).toHaveLength(0);
    });
    test.each(['runner', 'direct'])('missing options preserve startup initialization behavior: %s', async (mode) => {
        const originalParse = Command.prototype.parseAsync;
        jest.spyOn(Command.prototype, 'parseAsync').mockImplementation(function (this: Command, ...args) {
            overrideExits(this);
            return originalParse.apply(this, args);
        });
        const output = jest.fn();
        const diagnostic = jest.fn();
        const options = { homeDirectory: home, writeLine: output, writeDiagnostic: diagnostic };
        await expect(mode === 'runner' ? runDefaultCamundaCli(['node', 'cli', 'incident', 'retry'], options) :
            createDefaultCamundaCli(options).parseAsync(['incident', 'retry'], { from: 'user' })).rejects.toThrow('required option');
        expect(output).not.toHaveBeenCalled();
        expect(diagnostic).toHaveBeenCalledTimes(mode === 'runner' ? 1 : 0);
        expect(requests).toHaveLength(0);
    });
});
