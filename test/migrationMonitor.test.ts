import { AxiosInstance, RawAxiosRequestConfig } from 'axios';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    AxiosMigrationMonitorAdapter, ConsoleMigrationMonitorPresenter, MigrationMonitorUseCase,
    migrationMonitorReport, MonitorDefinition, MonitorInstance, OperateConnection, Profile,
    createCamundaCli, createDefaultCamundaCli, runDefaultCamundaCli,
} from '../src';

const connection: OperateConnection = { operateUrl: 'https://operate.example/proxy/v1', oAuthUrl: 'https://auth.example/token',
    clientId: 'dummy-client', clientSecret: 'dummy+secret&= /', audience: 'operate-only' };
const profile: Profile = { name: 'selected', baseUrl: 'unused', ...connection };
const definition = (key: string, version: number, bpmnProcessId = 'orders', tenantId?: string): MonitorDefinition =>
    ({ key, version, bpmnProcessId, tenantId });
const instance = (key: string, source: MonitorDefinition): MonitorInstance => ({ key, processDefinitionKey: source.key,
    processVersion: source.version, bpmnProcessId: source.bpmnProcessId, tenantId: source.tenantId });
const empty = '{"items":[],"total":10000}';
function page(items: object[], cursor?: string): string {
    return `{"items":${JSON.stringify(items)},"sortValues":${cursor ?? JSON.stringify([String((items[items.length - 1] as { key: string }).key)])},"total":10000}`;
}
function mockAdapter() {
    const post = jest.fn();
    const request = jest.fn((config: RawAxiosRequestConfig) => post(config.url, config.data, config));
    const adapter = new AxiosMigrationMonitorAdapter({ post, request } as unknown as AxiosInstance);
    return { adapter, post };
}
function script(post: jest.Mock, ...bodies: string[]): void {
    for (const data of ['{"access_token":"dummy-token"}', ...bodies]) post.mockResolvedValueOnce({ status: 200, data });
}

describe('migration monitor report', () => {
    test('latest uninstantiated deployment, all-version totals, numeric sorting, names and tenant isolation', () => {
        const a = definition('1', 1, 'orders', 'a');
        const b = definition('2', 2, 'orders', 'a');
        const c = definition('3', 10, 'orders', 'a');
        const d = definition('4', 11, 'orders', 'a');
        const e = definition('5', 1, 'orders', 'b');
        const f = definition('6', 2, 'orders', 'b');
        const g = definition('7', 1, 'another');
        const h = definition('8', 2, 'another');
        const rows = migrationMonitorReport([d, c, b, a, f, e, h, g].map((item) => item === d ? { ...item, name: 'Latest name' } : item),
            [instance('101', b), instance('102', c), instance('103', a), instance('104', a), instance('105', e), instance('106', f), instance('107', g)]);
        expect(rows).toEqual([
            { processName: 'another', bpmnProcessId: 'another', tenantId: undefined, latestVersion: 2, activeInstances: 1,
                outdatedVersions: [{ version: 1, activeInstances: 1 }] },
            { processName: 'Latest name', bpmnProcessId: 'orders', tenantId: 'a', latestVersion: 11, activeInstances: 4,
                outdatedVersions: [{ version: 1, activeInstances: 2 }, { version: 2, activeInstances: 1 }, { version: 10, activeInstances: 1 }] },
            { processName: 'orders', bpmnProcessId: 'orders', tenantId: 'b', latestVersion: 2, activeInstances: 2,
                outdatedVersions: [{ version: 1, activeInstances: 1 }] },
        ]);
    });

    test('empty and up-to-date processes do not appear', () => {
        const latest = definition('2', 2);
        expect(migrationMonitorReport([], [])).toEqual([]);
        expect(migrationMonitorReport([definition('1', 1), latest], [instance('3', latest)])).toEqual([]);
        expect(migrationMonitorReport([latest], [])).toEqual([]);
    });

    test.each(['missing', 'tenant', 'version', 'id', 'duplicate-instance', 'duplicate-definition', 'duplicate-version'])('fails safely on %s', (problem) => {
        const source = definition('1', 1);
        const active = instance('3', source);
        const definitions = [source];
        const instances = [active];
        if (problem === 'missing') definitions.pop();
        if (problem === 'tenant') active.tenantId = 'different';
        if (problem === 'version') active.processVersion = 2;
        if (problem === 'id') active.bpmnProcessId = 'different';
        if (problem === 'duplicate-instance') instances.push(active);
        if (problem === 'duplicate-definition') definitions.push(source);
        if (problem === 'duplicate-version') definitions.push(definition('2', 1));
        expect(() => migrationMonitorReport(definitions, instances)).toThrow(/retry/i);
    });

    test('table escapes controls and displays required semantics and tenant', () => {
        const write = jest.fn();
        const first = definition('1', 1);
        const second = definition('2', 2);
        const latest = { ...definition('3', 3), name: '\u001b[31m\n\u202e' };
        const rows = migrationMonitorReport([first, second, latest],
            [first, first, first, second, second, latest, latest, latest, latest].map((source, index) => instance(String(100 + index), source)));
        rows[0].tenantId = 'tenant\r';
        new ConsoleMigrationMonitorPresenter(write).showMigrationMonitor(rows);
        const output = write.mock.calls[0][0];
        expect(output).toContain('Process definition id');
        expect(output).toContain('Active instances');
        expect(output).toContain('Latest version');
        expect(output).toContain('Number of outdated instances');
        expect(output).not.toContain('Outdated versions');
        // Five instances on two older versions; four latest-version instances count only in the active total.
        expect(output.split('\n')[1].split('|').map((cell: string) => cell.trim())).toEqual([
            'tenant\\u000d', '\\u001b[31m\\u000a\\u202e', 'orders', '3', '9', '5',
        ]);
        expect(output).toContain('tenant\\u000d');
        expect(output).toContain('\\u001b[31m\\u000a\\u202e');
        expect(output.split('\n').pop()).toBe('Total (displayed processes): Active instances: 9 | Number of outdated instances: 5');
        new ConsoleMigrationMonitorPresenter(write).showMigrationMonitor([]);
        expect(write).toHaveBeenLastCalledWith('No active process instances on outdated versions found.\nTotal (displayed processes): Active instances: 0 | Number of outdated instances: 0');
    });

    test('summary totals displayed processes across tenants and versions, excluding up-to-date-only processes', () => {
        const a1 = definition('1', 1, 'orders', 'a');
        const a2 = definition('2', 2, 'orders', 'a');
        const a3 = definition('3', 3, 'orders', 'a');
        const b1 = definition('4', 1, 'orders', 'b');
        const b2 = definition('5', 2, 'orders', 'b');
        const current = definition('6', 1, 'up-to-date', 'a');
        const sources = [a1, a1, a1, a2, a2, a3, a3, a3, a3, b1, b1, b2, current, current];
        const rows = migrationMonitorReport([a1, a2, a3, b1, b2, current],
            sources.map((source, index) => instance(String(100 + index), source)));
        const write = jest.fn();
        new ConsoleMigrationMonitorPresenter(write).showMigrationMonitor(rows);
        const lines = write.mock.calls[0][0].split('\n');
        expect(lines).toHaveLength(4);
        expect(lines[1].split('|').map((cell: string) => cell.trim())).toEqual(['a', 'orders', 'orders', '3', '9', '5']);
        expect(lines[2].split('|').map((cell: string) => cell.trim())).toEqual(['b', 'orders', 'orders', '2', '3', '2']);
        expect(lines[3]).toBe('Total (displayed processes): Active instances: 12 | Number of outdated instances: 7');
        expect(write.mock.calls[0][0]).not.toContain('up-to-date');
    });
});

describe('Operate read-only discovery', () => {
    test('reads every page despite short pages/capped totals, preserves int64 keys and complete cursor', async () => {
        const { adapter, post } = mockAdapter();
        const first = '9007199254740993';
        const second = '9007199254740995';
        const source = definition(first, 1);
        const cursor = `[${first},"tie-breaker",9007199254740999,null]`;
        const raw = page([source], cursor).replace(`"key":"${first}"`, `"key":${first}`);
        const active = { ...instance('9007199254740997', source), state: 'ACTIVE', incident: true };
        const rawActive = page([active]).replace('"key":"9007199254740997"', '"key":9007199254740997')
            .replace(`"processDefinitionKey":"${first}"`, `"processDefinitionKey":${first}`);
        script(post, raw, page([definition(second, 2)]), empty, rawActive, empty);
        const discovered = await adapter.discover(connection);
        expect(discovered.definitions.map((item) => item.key)).toEqual([first, second]);
        expect(discovered.instances[0]).toMatchObject({ key: '9007199254740997', processDefinitionKey: first });
        expect(migrationMonitorReport(discovered.definitions, discovered.instances)[0].outdatedVersions).toEqual([{ version: 1, activeInstances: 1 }]);
        expect(post.mock.calls.map(([url]) => url)).toEqual([connection.oAuthUrl,
            ...Array(3).fill('https://operate.example/proxy/v1/process-definitions/search'),
            ...Array(2).fill('https://operate.example/proxy/v1/process-instances/search')]);
        expect(post.mock.calls[2][1]).toContain(`"searchAfter":${cursor}`);
        expect(JSON.parse(post.mock.calls[1][1])).toEqual({ filter: {}, size: 100, sort: [{ field: 'key', order: 'ASC' }] });
        expect(JSON.parse(post.mock.calls[4][1]).filter).toEqual({ state: 'ACTIVE' });
        expect(new URLSearchParams(post.mock.calls[0][1]).get('audience')).toBe('operate-only');
        expect(new URLSearchParams(post.mock.calls[0][1]).get('client_secret')).toBe(connection.clientSecret);
        for (const [, , config] of post.mock.calls) expect(config.maxRedirects).toBe(0);
        expect(post.mock.calls[1][2].headers.Authorization).toBe('Bearer dummy-token');
    });

    test.each(['COMPLETED', 'CANCELED', undefined])('rejects unexpected state %s rather than falsely reporting clean', async (state) => {
        const { adapter, post } = mockAdapter();
        const source = definition('1', 1);
        script(post, page([source]), empty, page([{ ...instance('2', source), state }]));
        await expect(adapter.discover(connection)).rejects.toThrow(/retry/i);
    });

    test.each([
        '{"items":[{"key":1,"version":1,"bpmnProcessId":"p"}]}',
        '{"items":[{"key":1,"version":1,"bpmnProcessId":"p"}],"sortValues":[2]}',
        '{"items":[{"key":1,"version":1,"bpmnProcessId":"p"}],"sortValues":[1,{}]}',
        '{"items":[{"key":2,"version":1,"bpmnProcessId":"p"},{"key":1,"version":2,"bpmnProcessId":"p"}],"sortValues":[1]}',
        '{"items":[{"key":9223372036854775808,"version":1,"bpmnProcessId":"p"}],"sortValues":[9223372036854775808]}',
        '{"items":[{"key":1,"version":"1","bpmnProcessId":"p"}],"sortValues":[1]}',
        '{"items":null}',
    ])('rejects malformed discovery %s', async (body) => {
        const { adapter, post } = mockAdapter();
        script(post, body);
        await expect(adapter.discover(connection)).rejects.toThrow(/retry/i);
    });

    test('rejects repeated pages/nonprogress', async () => {
        const { adapter, post } = mockAdapter();
        const body = page([definition('1', 1)]);
        script(post, body, body);
        await expect(adapter.discover(connection)).rejects.toThrow(/retry/i);
        expect(post).toHaveBeenCalledTimes(3);
    });

    test.each(['auth', 'api', 'malformed', 'token', 'redirect'])('redacts %s failures including nested causes', async (stage) => {
        const { adapter, post } = mockAdapter();
        const error = { isAxiosError: true, message: 'dummy-secret', response: { status: 401, data: 'dummy-secret' }, config: { token: 'dummy-secret' } };
        if (stage === 'auth') post.mockRejectedValueOnce(error);
        if (stage === 'api') { script(post); post.mockRejectedValueOnce(error); }
        if (stage === 'malformed') post.mockResolvedValueOnce({ status: 200, data: 'dummy-secret' });
        if (stage === 'token') post.mockResolvedValueOnce({ status: 200, data: '{"access_token":"dummy-secret\\n"}' });
        if (stage === 'redirect') post.mockResolvedValueOnce({ status: 307, data: 'dummy-secret' });
        let failure: Error | undefined;
        try { await adapter.discover(connection); } catch (error) { failure = error as Error; }
        expect(failure).toBeInstanceOf(Error);
        expect(failure!.message).not.toContain('dummy-secret');
        expect(failure).not.toHaveProperty('cause');
    });
});

describe('profile, CLI and runtime composition', () => {
    afterEach(() => jest.restoreAllMocks());

    test.each(['', ' \t ', 'missing'])('rejects blank/missing selected profile %j before discovery', async (name) => {
        const discover = jest.fn();
        const presenter = { showMigrationMonitor: jest.fn() };
        const usecase = new MigrationMonitorUseCase({ getProfile: () => undefined }, { discover }, presenter);
        await expect(usecase.monitorMigration({ profile: name })).rejects.toThrow();
        expect(discover).not.toHaveBeenCalled();
        expect(presenter.showMigrationMonitor).not.toHaveBeenCalled();
    });

    test.each(['operateUrl', 'oAuthUrl', 'clientId', 'clientSecret'] as const)('requires nonblank %s before discovery', async (field) => {
        for (const value of [undefined, '', ' \t ']) {
            const discover = jest.fn();
            const usecase = new MigrationMonitorUseCase({ getProfile: () => ({ ...profile, [field]: value }) }, { discover }, { showMigrationMonitor: jest.fn() });
            await expect(usecase.monitorMigration({ profile: 'selected' })).rejects.toThrow(field);
            expect(discover).not.toHaveBeenCalled();
        }
    });

    test('forwards Operate-only OAuth settings, trims selected name and never requires gateway', async () => {
        const getProfile = jest.fn(() => ({ ...profile, baseUrl: '', operateAudience: 'override' }));
        const discover = jest.fn().mockResolvedValue({ definitions: [], instances: [] });
        const showMigrationMonitor = jest.fn();
        await new MigrationMonitorUseCase({ getProfile }, { discover }, { showMigrationMonitor }).monitorMigration({ profile: ' selected ' });
        expect(getProfile).toHaveBeenCalledWith('selected');
        expect(discover).toHaveBeenCalledWith({ ...connection, audience: 'override' });
        expect(showMigrationMonitor).toHaveBeenCalledWith([]);
    });

    test('missing required --profile is a CLI error', async () => {
        const cli = createCamundaCli({}).exitOverride();
        cli.commands.forEach((command) => command.exitOverride().configureOutput({ writeErr: () => undefined }));
        await expect(cli.parseAsync(['migration-monitor'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    });

    test('default runtime selects stored profile, produces only report on stdout, routes startup notices to diagnostics', async () => {
        const home = await mkdtemp(path.join(tmpdir(), 'migration-monitor-'));
        try {
            const output = jest.fn();
            const diagnostic = jest.fn();
            const discover = jest.spyOn(AxiosMigrationMonitorAdapter.prototype, 'discover').mockResolvedValue({ definitions: [], instances: [] });
            await expect(runDefaultCamundaCli(['node', 'cli', 'migration-monitor', '--profile', 'selected'],
                { homeDirectory: home, writeLine: output, writeDiagnostic: diagnostic })).rejects.toThrow('does not exist');
            expect(output).not.toHaveBeenCalled();
            expect(diagnostic).toHaveBeenCalledWith('Please add a profile with the add profile command.');
            await mkdir(path.join(home, '.lmoesle-camunda-cli'), { recursive: true });
            await writeFile(path.join(home, '.lmoesle-camunda-cli/profiles.json'), JSON.stringify({ profiles: [profile] }));
            await createDefaultCamundaCli({ homeDirectory: home, writeLine: output, writeDiagnostic: diagnostic })
                .parseAsync(['migration-monitor', '--profile', 'selected'], { from: 'user' });
            expect(discover).toHaveBeenCalledWith(connection);
            expect(output.mock.calls).toEqual([['No active process instances on outdated versions found.\nTotal (displayed processes): Active instances: 0 | Number of outdated instances: 0']]);
            output.mockClear();
            discover.mockResolvedValue({ definitions: [], instances: [instance('3', definition('1', 1))] });
            await expect(runDefaultCamundaCli(['node', 'cli', 'migration-monitor', '--profile', 'selected'],
                { homeDirectory: home, writeLine: output, writeDiagnostic: diagnostic })).rejects.toThrow(/retry/i);
            expect(output).not.toHaveBeenCalled();
        } finally { await rm(home, { recursive: true, force: true }); }
    });
});
