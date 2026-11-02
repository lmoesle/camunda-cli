import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import axios from 'axios';
import {
    AxiosDeploymentAdapter, AxiosIncidentAdapter, AxiosIncidentRetryAdapter, AxiosMigrationAdapter,
    AxiosMigrationMonitorAdapter, AxiosOperateApiAdapter, createCamundaCli, createDefaultCamundaCli,
    JsonProfileRepositoryAdapter, operateConnection, Profile, ProfileCache,
    prepareOperateRequest,
} from '../src';
import { createProfile } from '../src/domain/profile';
import { restConnection } from '../src/domain/restConnection';
import { deploymentConnection } from '../src/domain/deployment';
import { migrationConnection } from '../src/domain/migration';

const minimal = { name: 'local', baseUrl: 'http://localhost:8080', operateUrl: 'http://localhost:8081', zeebeUrl: 'http://localhost:26500' };

describe('explicit anonymous profile configuration', () => {
    let home: string;
    beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'no-auth-profiles-')); });
    afterEach(async () => { await rm(home, { recursive: true, force: true }); });

    test.each([true, false, undefined])('roundtrips noAuth=%s through creation, storage, startup and snapshots', async (noAuth) => {
        const input = { ...minimal, ...(noAuth === undefined ? {} : { noAuth }) };
        expect(createProfile(input)).toEqual(input);
        const repository = new JsonProfileRepositoryAdapter(home);
        await repository.addProfile(input);
        const stored = JSON.parse(await readFile(path.join(home, '.lmoesle-camunda-cli/profiles.json'), 'utf8'));
        expect(stored.profiles).toEqual([input]);
        const program = createDefaultCamundaCli({ homeDirectory: home, writeLine: jest.fn() });
        await program.initialize();
        expect(program.profiles.getProfile('local')).toEqual(input);
        const snapshot = program.profiles.getProfile('local')!;
        snapshot.noAuth = !noAuth;
        expect(program.profiles.getProfile('local')).toEqual(input);
    });

    test.each(['true', 1, null, {}, []])('rejects invalid noAuth %j on creation and loading', async (value) => {
        expect(() => createProfile({ ...minimal, noAuth: value } as Profile)).toThrow('boolean');
        const directory = path.join(home, '.lmoesle-camunda-cli');
        await mkdir(directory);
        await writeFile(path.join(directory, 'profiles.json'), JSON.stringify({ profiles: [{ ...minimal, noAuth: value }] }));
        await expect(new JsonProfileRepositoryAdapter(home).listProfiles()).rejects.toThrow();
    });

    test.each([true, false])('maps Commander negation without leaking auth (flag present=%s)', async (present) => {
        const addProfile = jest.fn();
        await createCamundaCli({ addProfileInPort: { addProfile } }).parseAsync([
            'add', 'profile', '--name', 'local', '--base-url', minimal.baseUrl,
            '--operate-url', minimal.operateUrl, '--zeebe-url', minimal.zeebeUrl, ...(present ? ['--no-auth'] : []),
        ], { from: 'user' });
        expect(addProfile).toHaveBeenCalledWith({ ...minimal, oAuthUrl: undefined, ...(present ? { noAuth: true } : {}) });
    });

    test('default CLI persists --no-auth without OAuth fields', async () => {
        await createDefaultCamundaCli({ homeDirectory: home, writeLine: jest.fn() }).parseAsync([
            'add', 'profile', '--name', 'local', '--base-url', minimal.baseUrl,
            '--operate-url', minimal.operateUrl, '--zeebe-url', minimal.zeebeUrl, '--no-auth',
        ], { from: 'user' });
        expect(await new JsonProfileRepositoryAdapter(home).listProfiles()).toEqual([{ ...minimal, noAuth: true }]);
    });

    test('keeps unknown stored keys and immutable cache selection', async () => {
        const directory = path.join(home, '.lmoesle-camunda-cli');
        await mkdir(directory);
        const original = { ...minimal, name: ' local ', noAuth: true, clientSecret: ' dummy secret ', future: { value: 1 } };
        await writeFile(path.join(directory, 'profiles.json'), JSON.stringify({ profiles: [original] }));
        const profiles = await new JsonProfileRepositoryAdapter(home).listProfiles();
        expect(profiles).toEqual([original]);
        const cache = new ProfileCache();
        cache.replaceProfiles(profiles);
        profiles[0].noAuth = false;
        expect(cache.getProfile('local')).toEqual(original);
    });
});

describe('anonymous connection builders', () => {
    const profile = { ...minimal, noAuth: true, oAuthUrl: 'not a URL', clientId: '', clientSecret: '', audience: '', operateAudience: '' };
    test('ignores even malformed retained OAuth settings before SaaS detection', () => {
        expect(operateConnection(profile, 'api')).toEqual({ operateUrl: minimal.operateUrl, noAuth: true });
        expect(restConnection(profile, 'retry')).toEqual({ restUrl: `${minimal.baseUrl}/v2`, noAuth: true });
        expect(deploymentConnection(profile)).toEqual({ deploymentsUrl: `${minimal.baseUrl}/v2/deployments`, noAuth: true });
        expect(migrationConnection(profile)).toEqual({ gatewayUrl: `${minimal.baseUrl}/v2`, operateUrl: `${minimal.operateUrl}/v1`, noAuth: true });
        expect(() => operateConnection({ ...profile, operateUrl: 'https://x.operate.camunda.io' }, 'api')).not.toThrow();
    });
    test.each([undefined, false])('keeps existing authentication validation for noAuth=%s', (noAuth) => {
        expect(() => operateConnection({ ...profile, noAuth }, 'api')).toThrow();
        expect(() => restConnection({ ...profile, noAuth }, 'retry')).toThrow();
        expect(() => migrationConnection({ ...profile, noAuth })).toThrow();
        expect(restConnection({ ...minimal, noAuth }, 'retry').oauth).toBeUndefined();
        expect(migrationConnection({ ...minimal, noAuth }).oauth).toBeUndefined();
    });
    test('still validates required service endpoints', () => {
        expect(() => operateConnection({ ...profile, operateUrl: 'ftp://bad' }, 'api')).toThrow('HTTP(S)');
        expect(() => restConnection({ ...profile, baseUrl: 'http://user:secret@localhost' }, 'retry')).toThrow();
        expect(() => migrationConnection({ ...profile, operateUrl: undefined })).toThrow('operateUrl');
    });

    test('only literal true disables authentication at domain boundaries', () => {
        const invalid = { ...profile, noAuth: 'true' } as unknown as Profile;
        expect(() => operateConnection(invalid, 'api')).toThrow();
        expect(() => restConnection(invalid, 'retry')).toThrow();
        expect(() => migrationConnection(invalid)).toThrow();
    });
});

describe('anonymous wire transport', () => {
    let server: Server;
    let root: string;
    let received: { path: string; headers: IncomingHttpHeaders }[];
    let responses: { status?: number; body?: unknown }[];
    let profile: Profile;
    const request = () => prepareOperateRequest('byKey_1', '{"path":{"key":1}}');

    beforeEach(async () => {
        received = [];
        responses = [];
        server = createServer((req, res) => {
            received.push({ path: req.url!, headers: req.headers });
            req.resume();
            const next = responses.shift() ?? { status: 500 };
            res.writeHead(next.status ?? 200, { 'Content-Type': 'application/json' });
            res.end(next.body === undefined ? undefined : JSON.stringify(next.body));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        profile = { name: 'local', baseUrl: root, operateUrl: root, noAuth: true,
            oAuthUrl: `${root}/token`, clientId: 'dummy', clientSecret: 'dummy' };
    });
    afterEach(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

    function pollutedHttp() {
        return axios.create({ auth: { username: 'dummy', password: 'dummy' }, headers: {
            common: { Authorization: 'Bearer stale', Cookie: 'dummy=session', 'Proxy-Authorization': 'Basic dummy' },
            post: { Authorization: 'Bearer stale-post', Cookie: 'dummy=post' },
        } });
    }
    function anonymousOnly() {
        expect(responses).toHaveLength(0);
        expect(received.length).toBeGreaterThan(0);
        for (const call of received) {
            expect(call.path).not.toBe('/token');
            expect(call.headers.authorization).toBeUndefined();
            expect(call.headers['proxy-authorization']).toBeUndefined();
            expect(call.headers.cookie).toBeUndefined();
        }
    }

    test('api strips inherited credentials without mutating defaults', async () => {
        const http = pollutedHttp();
        responses.push({ body: { key: '1' } });
        await new AxiosOperateApiAdapter(http).execute(operateConnection(profile, 'api'), request());
        anonymousOnly();
        expect(http.defaults.auth?.username).toBe('dummy');
        expect(http.defaults.headers.common.Authorization).toBe('Bearer stale');
    });

    test('CLI --profile selects anonymous API with polluted global Axios defaults', async () => {
        const home = await mkdtemp(path.join(tmpdir(), 'no-auth-wire-'));
        const auth = axios.defaults.auth;
        const headers = { ...axios.defaults.headers.common };
        try {
            axios.defaults.auth = { username: 'dummy', password: 'dummy' };
            axios.defaults.headers.common.Authorization = 'Bearer inherited';
            axios.defaults.headers.common.Cookie = 'dummy=inherited';
            await new JsonProfileRepositoryAdapter(home).addProfile(profile);
            responses.push({ body: { key: '1' } });
            await createDefaultCamundaCli({ homeDirectory: home, writeLine: jest.fn() }).parseAsync([
                'api', 'byKey_1', '{"path":{"key":1}}', '--profile', 'local',
            ], { from: 'user' });
            anonymousOnly();
        } finally {
            axios.defaults.auth = auth;
            axios.defaults.headers.common = headers;
            await rm(home, { recursive: true, force: true });
        }
    });

    test('incidents paginates anonymously on every page', async () => {
        responses.push({ body: { items: [{ key: '1', processInstanceKey: '2', state: 'ACTIVE', type: 'x', message: 'x', creationTime: 'x' }], sortValues: ['1'] } },
            { body: { items: [] } });
        expect(await new AxiosIncidentAdapter(pollutedHttp()).searchActiveIncidents(operateConnection(profile, 'incidents'))).toHaveLength(1);
        expect(received).toHaveLength(2);
        anonymousOnly();
    });

    test('migration monitor paginates both discovery searches anonymously', async () => {
        responses.push({ body: { items: [{ key: '1', bpmnProcessId: 'p', version: 1 }], sortValues: ['1'] } }, { body: { items: [] } },
            { body: { items: [{ key: '2', bpmnProcessId: 'p', processDefinitionKey: '1', processVersion: 1, state: 'ACTIVE' }], sortValues: ['2'] } }, { body: { items: [] } });
        const result = await new AxiosMigrationMonitorAdapter(pollutedHttp()).discover(operateConnection(profile, 'monitor'));
        expect(result.instances).toHaveLength(1);
        expect(received).toHaveLength(4);
        anonymousOnly();
    });

    test('deploy and both retry mutations strip inherited credentials', async () => {
        responses.push({ body: { deploymentKey: '1' } }, { status: 204 }, { status: 204 });
        const deploy = await new AxiosDeploymentAdapter(pollutedHttp()).connect(deploymentConnection(profile));
        expect(await deploy.deploy({ filename: 'dummy.txt', bytes: new Uint8Array([1]) })).toBe('1');
        const retry = await new AxiosIncidentRetryAdapter(pollutedHttp()).connect(restConnection(profile, 'retry'));
        await retry.resetJobRetries('1');
        await retry.resolveIncident('2');
        expect(received.map((call) => call.path)).toEqual(['/v2/deployments', '/v2/jobs/1', '/v2/incidents/2/resolution']);
        anonymousOnly();
    });

    test('migration uses anonymous Operate pages and gateway mutation', async () => {
        responses.push({ body: { items: [{ key: '1', bpmnProcessId: 'p', version: 1 }], sortValues: ['1'] } }, { body: { items: [] } },
            { body: { items: [{ key: '2', processDefinitionKey: '1', state: 'ACTIVE' }], sortValues: ['2'] } }, { body: { items: [] } }, { status: 204 });
        const session = await new AxiosMigrationAdapter(pollutedHttp()).connect(migrationConnection(profile));
        const definitions = await session.searchDefinitions('p', 1);
        expect(await session.searchActiveInstances(definitions[0])).toHaveLength(1);
        await session.migrate('2', '3', []);
        expect(received).toHaveLength(5);
        expect(received[4].path).toBe('/v2/process-instances/2/migration');
        anonymousOnly();
    });

    test.each(['api', 'incidents', 'monitor', 'deploy', 'retry', 'migrate'])('%s never falls back to OAuth after 401/403', async (family) => {
        for (const status of [401, 403]) {
            received = [];
            responses.push({ status });
            const http = pollutedHttp();
            const send = async () => {
                switch (family) {
                case 'api': return new AxiosOperateApiAdapter(http).execute(operateConnection(profile, 'api'), request());
                case 'incidents': return new AxiosIncidentAdapter(http).searchActiveIncidents(operateConnection(profile, 'incidents'));
                case 'monitor': return new AxiosMigrationMonitorAdapter(http).discover(operateConnection(profile, 'monitor'));
                case 'deploy': return (await new AxiosDeploymentAdapter(http).connect(deploymentConnection(profile)))
                    .deploy({ filename: 'dummy.txt', bytes: new Uint8Array([1]) });
                case 'retry': return (await new AxiosIncidentRetryAdapter(http).connect(restConnection(profile, 'retry'))).resolveIncident('1');
                default: return (await new AxiosMigrationAdapter(http).connect(migrationConnection(profile))).searchDefinitions('p', 1);
                }
            };
            await expect(send()).rejects.toThrow(`HTTP ${status}`);
            expect(received).toHaveLength(1);
            anonymousOnly();
        }
    });

    test('migration isolates both audience tokens when switching profiles on the same adapter', async () => {
        const adapter = new AxiosMigrationAdapter(axios.create());
        for (const noAuth of [false, true, false]) {
            const start = received.length;
            if (!noAuth) responses.push({ body: { access_token: 'operate-token' } }, { body: { access_token: 'gateway-token' } });
            responses.push({ body: { items: [] } }, { status: 204 });
            const session = await adapter.connect(migrationConnection({ ...profile, noAuth }));
            await session.searchDefinitions('p', 1);
            await session.migrate('1', '2', []);
            const calls = received.slice(start);
            expect(calls.filter((call) => call.path === '/token')).toHaveLength(noAuth ? 0 : 2);
            const clusterCalls = calls.filter((call) => call.path !== '/token');
            expect(clusterCalls.map((call) => call.headers.authorization)).toEqual(noAuth ? [undefined, undefined] : ['Bearer operate-token', 'Bearer gateway-token']);
        }
    });

    test('reusing adapters across authenticated -> anonymous -> authenticated selections never reuses stale tokens', async () => {
        const http = axios.create();
        const cache = new ProfileCache();
        cache.replaceProfiles([profile, { ...profile, name: 'authenticated', noAuth: false }]);
        const adapters = [new AxiosOperateApiAdapter(http), new AxiosIncidentAdapter(http), new AxiosMigrationMonitorAdapter(http)];
        for (const adapter of adapters) {
            for (const name of ['authenticated', 'local', 'authenticated']) {
                const anonymous = name === 'local';
                const start = received.length;
                if (!anonymous) responses.push({ body: { access_token: 'fresh-token' } });
                responses.push({ body: { items: [] } });
                if (adapter instanceof AxiosMigrationMonitorAdapter) responses.push({ body: { items: [] } });
                const connection = operateConnection(cache.getProfile(name)!, 'test');
                if (adapter instanceof AxiosOperateApiAdapter) await adapter.execute(connection, request());
                else if (adapter instanceof AxiosIncidentAdapter) await adapter.searchActiveIncidents(connection);
                else await adapter.discover(connection);
                const calls = received.slice(start);
                expect(calls.filter((call) => call.path === '/token')).toHaveLength(anonymous ? 0 : 1);
                for (const call of calls.filter((call) => call.path !== '/token')) {
                    expect(call.headers.authorization).toBe(anonymous ? undefined : 'Bearer fresh-token');
                }
            }
        }
    });
});
