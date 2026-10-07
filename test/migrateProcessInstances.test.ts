import axios, { AxiosInstance } from 'axios';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AxiosMigrationAdapter, ConsoleMigrationsPresenter, createCamundaCli, migrationConnection, migrationPlan,
    MigrateProcessInstancesUseCase, Profile, ListIncidentsUseCase, createDefaultCamundaCli, runDefaultCamundaCli,
    JsonProfileRepositoryAdapter, MigrationBatchFailure } from '../src';

const entry = { processDefinition: 'processDefinitionId', sourceVersion: 'v1', targetVersion: 'v2',
    mappingInstructions: [{ sourceElementId: 'Task_Old', targetElementId: 'Task_New' }] };
const local: Profile = { name: 'selected', baseUrl: 'http://gateway.example/proxy/v2/', operateUrl: 'http://operate.example/proxy/v1/' };
const connection = migrationConnection(local);
const definition = (key = '1', version = 1) => ({ key, version, bpmnProcessId: entry.processDefinition });
const instance = (key = '10', processDefinitionKey = '1') => ({ key, processDefinitionKey, state: 'ACTIVE' as const });
const response = (data: string, status = 200) => ({ status, data });
function orchestration() {
    const searchDefinitions = jest.fn(async (_id: string, version: number) => [definition(String(version), version)]);
    const searchActiveInstances = jest.fn(async (source: { key: string }) => [instance('10', source.key)]);
    const migrate = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockResolvedValue({ searchDefinitions, searchActiveInstances, migrate });
    const presenter = { showMigrated: jest.fn(), showFailed: jest.fn(), showSummary: jest.fn() };
    return { searchDefinitions, searchActiveInstances, migrate, connect, presenter,
        usecase: new MigrateProcessInstancesUseCase({ getProfile: () => local }, { connect }, presenter) };
}
function http() {
    const post = jest.fn();
    return { post, adapter: new AxiosMigrationAdapter({ post } as unknown as AxiosInstance) };
}

describe('migration plan validation', () => {
    test.each([
        { scenario: 'outer plan', plan: new Array<unknown>(1), error: 'Migration plan entry 0: invalid fields.' },
        { scenario: 'first entry mappings', plan: [{ ...entry, mappingInstructions: new Array<unknown>(1) }],
            error: 'Migration plan entry 0: invalid mappingInstructions[0].' },
        { scenario: 'later entry mappings', plan: [entry, { ...entry, sourceVersion: 2, targetVersion: 3,
            mappingInstructions: new Array<unknown>(1) }], error: 'Migration plan entry 1: invalid mappingInstructions[0].' },
    ])('rejects sparse $scenario safely before connect', async ({ plan, error }) => {
        const state = orchestration();
        state.searchActiveInstances.mockResolvedValueOnce([instance()]).mockResolvedValueOnce([instance('20', '2')]);
        await expect(state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: plan })).rejects.toThrow(error);
        expect(state.connect).not.toHaveBeenCalled();
        expect(state.migrate).not.toHaveBeenCalled();
    });
    test('preserves valid dense array inputs and normalizes every entry', () => {
        const plan = [entry, { ...entry, sourceVersion: 2, targetVersion: 3, mappingInstructions: [] }];
        const original = JSON.stringify(plan);
        expect(migrationPlan(plan)).toEqual([
            { ...entry, sourceVersion: 1, targetVersion: 2 },
            { ...entry, sourceVersion: 2, targetVersion: 3, mappingInstructions: [] },
        ]);
        expect(JSON.stringify(plan)).toBe(original);
    });
    test.each([1, '1', 'v1', 'v0001'])('normalizes deployment version %j', (sourceVersion) => {
        expect(migrationPlan([{ ...entry, sourceVersion }])[0].sourceVersion).toBe(1);
    });
    test('accepts int32 boundary, empty mappings and many-to-one targets; preserves IDs', () => {
        expect(migrationPlan([{ ...entry, processDefinition: ' id ', targetVersion: 'v2147483647', mappingInstructions: [] }])[0])
            .toEqual({ processDefinition: ' id ', sourceVersion: 1, targetVersion: 2147483647, mappingInstructions: [] });
        expect(migrationPlan([{ ...entry, mappingInstructions: [entry.mappingInstructions[0], { sourceElementId: 'other', targetElementId: 'Task_New' }] }])).toHaveLength(1);
    });
    test.each([0, -1, 1.1, 2147483648, 'V1', '1.0', 'v1junk', ' 1', '1 ', '', '0', 'v-1', null])(
        'rejects invalid later version %j before connect', async (sourceVersion) => {
            const state = orchestration();
            await expect(state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry, { ...entry, sourceVersion }] }))
                .rejects.toThrow(/entry 1/);
            expect(state.connect).not.toHaveBeenCalled();
        });
    test.each([[], {}, 'bad json', [{ ...entry, typo: true }], [{ ...entry, processDefinition: ' ' }],
        [{ ...entry, targetVersion: 1 }], [entry, { ...entry, sourceVersion: 1 }],
        [{ ...entry, mappingInstructions: null }], [{ ...entry, mappingInstructions: [{ sourceElementId: ' ', targetElementId: 'x' }] }],
        [{ ...entry, mappingInstructions: [entry.mappingInstructions[0], entry.mappingInstructions[0]] }],
        [{ ...entry, mappingInstructions: [{ ...entry.mappingInstructions[0], typo: true }] }]].map((plan) => ({ plan })))('rejects invalid shape without payload echoes', ({ plan }) => {
        expect(() => migrationPlan(plan)).toThrow(/Migration plan/);
    });
});

describe('migration preflight and sequential execution', () => {
    test.each(['showMigrated', 'showFailed'] as const)('does not catch %s presenter errors as request failures', async (method) => {
        const state = orchestration();
        state.searchActiveInstances.mockResolvedValueOnce([instance('10'), instance('11')]);
        if (method === 'showFailed') state.migrate.mockRejectedValueOnce(new Error('HTTP 409'));
        const error = new Error('Presenter failed.');
        state.presenter[method].mockImplementation(() => { throw error; });
        await expect(state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry] })).rejects.toBe(error);
        expect(state.migrate).toHaveBeenCalledTimes(1);
        expect(state.presenter.showFailed).toHaveBeenCalledTimes(method === 'showFailed' ? 1 : 0);
        expect(state.presenter.showSummary).not.toHaveBeenCalled();
    });
    test.each(['target definition resolution', 'instance discovery'])('performs zero mutations when later %s fails', async (stage) => {
        const state = orchestration();
        if (stage === 'target definition resolution') {
            state.searchDefinitions.mockImplementation(async (_id, version) => version === 3 ? [] : [definition(String(version), version)]);
        } else {
            state.searchActiveInstances.mockResolvedValueOnce([instance()]).mockRejectedValueOnce(new Error('Later instance discovery failed.'));
        }
        await expect(state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry,
            { ...entry, sourceVersion: 2, targetVersion: 3 }] })).rejects.toThrow(
            stage === 'target definition resolution' ? /entry 1.*exactly one/ : /Later instance discovery failed/,
        );
        expect(state.searchActiveInstances).toHaveBeenNthCalledWith(1, definition());
        expect(state.searchActiveInstances).toHaveBeenCalledTimes(stage === 'target definition resolution' ? 1 : 2);
        expect(state.migrate).not.toHaveBeenCalled();
        expect(state.presenter.showMigrated).not.toHaveBeenCalled();
        expect(state.presenter.showSummary).not.toHaveBeenCalled();
    });
    test('collects chained snapshots before writes, sorts keys, and reports successes', async () => {
        const state = orchestration();
        state.searchActiveInstances.mockResolvedValueOnce([instance('11'), instance('10')]).mockResolvedValueOnce([instance('20', '2')]);
        state.migrate.mockImplementation(async () => { expect(state.searchActiveInstances).toHaveBeenCalledTimes(2); });
        await state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry, { ...entry, sourceVersion: 2, targetVersion: 3 }] });
        expect(state.migrate.mock.calls.map((call) => call.slice(0, 2))).toEqual([['10', '2'], ['11', '2'], ['20', '3']]);
        expect(state.presenter.showSummary).toHaveBeenCalledWith(3, 0);
    });
    test.each([[], [definition(), definition('3')]].map((definitions) => ({ definitions })))('rejects missing/ambiguous definitions', async ({ definitions }) => {
        const state = orchestration(); state.searchDefinitions.mockResolvedValueOnce(definitions);
        await expect(state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry] })).rejects.toThrow(/exactly one/);
        expect(state.migrate).not.toHaveBeenCalled();
    });
    test.each([{ ...definition('2', 2), tenantId: '<default>' }, definition('1', 2)])('rejects tenant mismatch/same key', async (target) => {
        const state = orchestration(); state.searchDefinitions.mockResolvedValueOnce([definition()]).mockResolvedValueOnce([target]);
        await expect(state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry] })).rejects.toThrow(/matching tenants/);
        expect(state.migrate).not.toHaveBeenCalled();
    });
    test('rejects duplicate batch candidates before mutation', async () => {
        const state = orchestration();
        await expect(state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry, { ...entry, sourceVersion: 2, targetVersion: 3 }] }))
            .rejects.toThrow(/duplicate/);
        expect(state.migrate).not.toHaveBeenCalled();
    });
    test('resets counters across empty, partially failed and successful invocations', async () => {
        const state = orchestration(); state.searchActiveInstances.mockResolvedValueOnce([]);
        await state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry] });
        expect(state.presenter.showSummary).toHaveBeenCalledWith(0, 0);
        state.presenter.showSummary.mockClear();
        state.searchActiveInstances.mockResolvedValueOnce([instance('10'), instance('11'), instance('12')]);
        state.migrate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('secret HTTP 409'));
        await expect(state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry] })).rejects.toMatchObject({
            successfulCount: 2, failedCount: 1,
        });
        expect(state.presenter.showFailed).toHaveBeenCalledWith(expect.stringMatching(/instance 11 after 1.*HTTP 409.*committed.*uncertain/));
        expect(state.migrate).toHaveBeenCalledTimes(3);
        expect(state.presenter.showMigrated).toHaveBeenCalledTimes(2);
        expect(state.presenter.showSummary).toHaveBeenCalledWith(2, 1);
        state.presenter.showSummary.mockClear();
        await state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry] });
        expect(state.presenter.showSummary).toHaveBeenCalledTimes(1);
        expect(state.presenter.showSummary).toHaveBeenCalledWith(1, 0);
    });
});

describe('migration failure continuation regression', () => {
    function regressionState() {
        const state = orchestration();
        const presenter = { ...state.presenter, showFailed: jest.fn() };
        return { ...state, presenter,
            usecase: new MigrateProcessInstancesUseCase({ getProfile: () => local }, { connect: state.connect }, presenter) };
    }

    test('attempts every snapshot in plan/key order after failure, without retries', async () => {
        const state = regressionState();
        state.searchActiveInstances.mockResolvedValueOnce([instance('12'), instance('10'), instance('11')])
            .mockResolvedValueOnce([instance('21', '2'), instance('20', '2')]);
        state.migrate.mockImplementation(async (key: string) => {
            expect(state.searchActiveInstances).toHaveBeenCalledTimes(2);
            if (key === '11') throw new Error('HTTP 409 dummy-secret');
        });
        // Recover the rejection so the baseline fails on early stopping, not on changed error wording.
        const result = await state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry,
            { ...entry, sourceVersion: 2, targetVersion: 3 }] }).catch((error: unknown) => error);
        expect(state.migrate.mock.calls.map((call) => call.slice(0, 2))).toEqual([
            ['10', '2'], ['11', '2'], ['12', '2'], ['20', '3'], ['21', '3'],
        ]);
        expect(state.migrate).toHaveBeenCalledTimes(5);
        expect(state.presenter.showMigrated.mock.calls).toEqual([
            ['10', migrationPlan([entry])[0]], ['12', migrationPlan([entry])[0]],
            ['20', migrationPlan([{ ...entry, sourceVersion: 2, targetVersion: 3 }])[0]],
            ['21', migrationPlan([{ ...entry, sourceVersion: 2, targetVersion: 3 }])[0]],
        ]);
        expect(result).toBeInstanceOf(Error);
    });

    test('reports a sanitized failure and exactly one final confirmed-success/failure summary before rejecting', async () => {
        const state = regressionState();
        state.searchActiveInstances.mockResolvedValueOnce([instance('10'), instance('11'), instance('12')]);
        state.migrate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('HTTP 409 dummy-secret'))
            .mockResolvedValueOnce(undefined);
        const result = await state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry] })
            .catch((error: unknown) => error);
        expect(state.presenter.showSummary).toHaveBeenCalledTimes(1);
        expect(state.presenter.showSummary).toHaveBeenCalledWith(2, 1);
        expect(state.presenter.showFailed).toHaveBeenCalledTimes(1);
        expect(state.presenter.showFailed).toHaveBeenCalledWith('Migration failed for instance 11 after 1 successful migrations (HTTP 409). Prior successes remain committed; the failed request outcome may be uncertain. No retry or rollback was attempted.');
        expect(state.presenter.showSummary.mock.invocationCallOrder[0])
            .toBeGreaterThan(state.presenter.showMigrated.mock.invocationCallOrder[1]);
        expect(state.presenter.showSummary.mock.invocationCallOrder[0])
            .toBeGreaterThan(state.presenter.showFailed.mock.invocationCallOrder[0]);
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).not.toContain('dummy-secret');
    });

    test('attempts all failed requests once and reports zero confirmed successes', async () => {
        const state = regressionState();
        state.searchActiveInstances.mockResolvedValueOnce([instance('11'), instance('10')]);
        state.migrate.mockRejectedValue(new Error('dummy-secret network failure'));
        const result = await state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry] })
            .catch((error: unknown) => error);
        expect(state.migrate.mock.calls.map((call) => call[0])).toEqual(['10', '11']);
        expect(state.migrate).toHaveBeenCalledTimes(2);
        expect(state.presenter.showMigrated).not.toHaveBeenCalled();
        expect(state.presenter.showFailed).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(state.presenter.showFailed.mock.calls)).not.toContain('dummy-secret');
        expect(state.presenter.showSummary).toHaveBeenCalledTimes(1);
        expect(state.presenter.showSummary).toHaveBeenCalledWith(0, 2);
        expect(result).toBeInstanceOf(Error);
    });

    test.each([0, 2])('reports one summary with zero failures for %i successful candidates', async (count) => {
        const state = regressionState();
        state.searchActiveInstances.mockResolvedValueOnce(count === 0 ? [] : [instance('10'), instance('11')]);
        await expect(state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry] }))
            .resolves.toBeUndefined();
        expect(state.migrate).toHaveBeenCalledTimes(count);
        expect(state.presenter.showMigrated).toHaveBeenCalledTimes(count);
        expect(state.presenter.showFailed).not.toHaveBeenCalled();
        expect(state.presenter.showSummary).toHaveBeenCalledTimes(1);
        expect(state.presenter.showSummary).toHaveBeenCalledWith(count, 0);
    });
});

describe('migration profile authentication', () => {
    test.each([{ clientId: 'only' }, { operateAudience: '' }, { audience: 'only' }, { operateUrl: undefined },
        { baseUrl: 'ftp://host' }, { operateUrl: 'http://dummy:secret@host' }, { baseUrl: 'http://host?' },
        { operateUrl: 'http://host#' }, { baseUrl: 'https://bru-1.zeebe.camunda.io/cluster' }])('rejects partial/unsafe config %j', (overrides) => {
        expect(() => migrationConnection({ ...local, ...overrides })).toThrow(/Profile/);
    });
    test('normalizes endpoint prefixes and requires both SaaS audiences', () => {
        expect(connection).toEqual({ gatewayUrl: 'http://gateway.example/proxy/v2', operateUrl: 'http://operate.example/proxy/v1' });
        const oauth = { clientId: 'id', clientSecret: 'secret', oAuthUrl: 'https://login.cloud.camunda.io/oauth/token', audience: 'zeebe.camunda.io' };
        expect(() => migrationConnection({ ...local, ...oauth })).toThrow('operateAudience');
        expect(migrationConnection({ ...local, ...oauth, operateAudience: 'operate.camunda.io' }).oauth?.operateAudience).toBe('operate.camunda.io');
    });
    test('uses distinct service tokens and preserves OAuth bytes', async () => {
        const { adapter, post } = http();
        post.mockResolvedValueOnce(response('{"access_token":"operate-token"}')).mockResolvedValueOnce(response('{"access_token":"gateway-token"}'))
            .mockResolvedValueOnce(response('{"items":[]}')).mockResolvedValueOnce(response('', 204));
        const oauth = { clientId: ' id+ ', clientSecret: ' secret&= ', oAuthUrl: 'https://auth.example/token', audience: ' gateway ', operateAudience: ' operate ' };
        const session = await adapter.connect({ ...connection, oauth });
        await session.searchDefinitions('id', 1); await session.migrate('10', '2', []);
        expect(Object.fromEntries(new URLSearchParams(post.mock.calls[0][1]))).toEqual({ grant_type: 'client_credentials', client_id: oauth.clientId, client_secret: oauth.clientSecret, audience: oauth.operateAudience });
        expect(new URLSearchParams(post.mock.calls[1][1]).get('audience')).toBe(oauth.audience);
        expect(post.mock.calls[2][2].headers.Authorization).toBe('Bearer operate-token');
        expect(post.mock.calls[3][2].headers.Authorization).toBe('Bearer gateway-token');
    });
    test('incidents respects Operate override and rejects blank override', async () => {
        const searchActiveIncidents = jest.fn().mockResolvedValue([]);
        const profile = { ...local, clientId: 'id', clientSecret: 'secret', oAuthUrl: 'http://auth/token', audience: 'gateway', operateAudience: 'operate' };
        const usecase = new ListIncidentsUseCase({ getProfile: () => profile }, { searchActiveIncidents }, { showIncidents: jest.fn() });
        await usecase.listIncidents({ profile: 'selected' });
        expect(searchActiveIncidents.mock.calls[0][0].audience).toBe('operate');
        profile.operateAudience = ' ';
        await expect(usecase.listIncidents({ profile: 'selected' })).rejects.toThrow('operateAudience');
    });
});

describe('Operate lossless discovery and migration HTTP', () => {
    test('snapshots every discovery page before writes and attempts later-page candidates after failure', async () => {
        const { adapter, post } = http();
        const presenter = { showMigrated: jest.fn(), showFailed: jest.fn(), showSummary: jest.fn() };
        const events: string[] = [];
        post.mockImplementation(async (url: string, data: string) => {
            const request = JSON.parse(data) as { filter?: { version: number }; searchAfter?: string[] };
            if (url.endsWith('/migration')) {
                events.push(url);
                expect(events.filter((event) => event === 'discovery')).toHaveLength(3);
                if (url.includes('/10/')) throw new Error('dummy-secret network failure');
                expect(presenter.showFailed).toHaveBeenCalledTimes(1);
                return response('', 204);
            }
            if (url.includes('process-definitions')) {
                const version = request.filter!.version;
                return response(JSON.stringify({ items: request.searchAfter ? [] : [definition(String(version), version)],
                    sortValues: [String(version)] }));
            }
            events.push('discovery');
            const items = !request.searchAfter ? [instance('10')] : request.searchAfter[0] === '10' ? [instance('20')] : [];
            return response(JSON.stringify({ items, sortValues: [items[0]?.key] }));
        });
        const usecase = new MigrateProcessInstancesUseCase({ getProfile: () => local }, adapter, presenter);
        await expect(usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry] }))
            .rejects.toBeInstanceOf(MigrationBatchFailure);
        expect(events).toEqual(['discovery', 'discovery', 'discovery',
            `${connection.gatewayUrl}/process-instances/10/migration`, `${connection.gatewayUrl}/process-instances/20/migration`]);
        expect(presenter.showMigrated).toHaveBeenCalledTimes(1);
        expect(presenter.showMigrated).toHaveBeenCalledWith('20', migrationPlan([entry])[0]);
        expect(presenter.showSummary).toHaveBeenCalledTimes(1);
        expect(presenter.showSummary).toHaveBeenCalledWith(1, 1);
        expect(presenter.showSummary.mock.invocationCallOrder[0]).toBeGreaterThan(post.mock.invocationCallOrder[post.mock.calls.length - 1]);
    });
    test.each(['unexpected dummy-secret content', ' ', '\n', { secret: 'dummy-secret' }, [], 0, false])(
        'rejects nonempty 204 content safely (%j)', async (data) => {
            const { adapter, post } = http(); const session = await adapter.connect(connection);
            post.mockResolvedValue({ status: 204, data });
            const migration = session.migrate('10', '2', []);
            await expect(migration).rejects.toThrow('Process instance migration failed (HTTP 204).');
            await expect(migration).rejects.not.toThrow('dummy-secret');
            expect(post).toHaveBeenCalledTimes(1);
        });
    test.each(['', undefined, null])('accepts empty 204 body (%j) without JSON parsing', async (data) => {
        const { adapter, post } = http(); const session = await adapter.connect(connection);
        post.mockResolvedValue({ status: 204, data });
        await expect(session.migrate('10', '2', [])).resolves.toBeUndefined();
        expect(post).toHaveBeenCalledTimes(1);
    });
    test('continues after nonempty 204 without counting the failed request as a success', async () => {
        const { adapter, post } = http();
        post.mockResolvedValueOnce(response(JSON.stringify({ items: [definition()], sortValues: ['1'] })))
            .mockResolvedValueOnce(response('{"items":[]}'))
            .mockResolvedValueOnce(response(JSON.stringify({ items: [definition('2', 2)], sortValues: ['2'] })))
            .mockResolvedValueOnce(response('{"items":[]}'))
            .mockResolvedValueOnce(response(JSON.stringify({ items: [instance('10'), instance('11'), instance('12')], sortValues: ['12'] })))
            .mockResolvedValueOnce(response('{"items":[]}'))
            .mockResolvedValueOnce(response('', 204))
            .mockResolvedValueOnce(response('unexpected dummy-secret content', 204))
            .mockResolvedValueOnce(response('', 204));
        const presenter = { showMigrated: jest.fn(), showFailed: jest.fn(), showSummary: jest.fn() };
        const usecase = new MigrateProcessInstancesUseCase({ getProfile: () => local }, adapter, presenter);
        const migration = usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: [entry] });
        await expect(migration).rejects.toMatchObject({ successfulCount: 2, failedCount: 1 });
        await expect(migration).rejects.not.toThrow('dummy-secret');
        expect(presenter.showFailed).toHaveBeenCalledWith(expect.stringMatching(/instance 11 after 1 successful migrations.*HTTP 204.*remain committed.*uncertain/));
        expect(JSON.stringify(presenter.showFailed.mock.calls)).not.toContain('dummy-secret');
        expect(post.mock.calls.filter(([url]) => url.endsWith('/migration')).map(([url]) => url)).toEqual([
            `${connection.gatewayUrl}/process-instances/10/migration`,
            `${connection.gatewayUrl}/process-instances/11/migration`,
            `${connection.gatewayUrl}/process-instances/12/migration`,
        ]);
        expect(presenter.showMigrated).toHaveBeenCalledTimes(2);
        expect(presenter.showMigrated).toHaveBeenCalledWith('10', migrationPlan([entry])[0]);
        expect(presenter.showSummary).toHaveBeenCalledTimes(1);
        expect(presenter.showSummary).toHaveBeenCalledWith(2, 1);
    });
    test('includes ACTIVE instances with incidents without an incident filter', async () => {
        const { adapter, post } = http(); const session = await adapter.connect(connection);
        post.mockResolvedValueOnce(response(JSON.stringify({ items: [{ ...instance(), incident: true }], sortValues: ['10'] })))
            .mockResolvedValueOnce(response('{"items":[]}'));
        expect(await session.searchActiveInstances(definition())).toEqual([instance()]);
        for (const call of post.mock.calls) {
            expect(JSON.parse(call[1]).filter).toEqual({ processDefinitionKey: 1, state: 'ACTIVE' });
            expect(JSON.parse(call[1]).filter).not.toHaveProperty('incident');
        }
    });
    test.each(['not JSON', '{}', '{"access_token":"bad\\nsecret"}'])('rejects malformed OAuth response safely', async (data) => {
        const { adapter, post } = http(); post.mockResolvedValue(response(data));
        await expect(adapter.connect({ ...connection, oauth: { clientId: 'id', clientSecret: 'secret', oAuthUrl: 'http://auth/token' } }))
            .rejects.toThrow(/OAuth authentication/);
        expect(post).toHaveBeenCalledTimes(1);
    });
    test.each([{}, { items: null }, { items: [{ ...instance(), state: 'COMPLETED' }], sortValues: ['10'] },
        { items: [{ ...instance(), processDefinitionKey: '2' }], sortValues: ['10'] },
        { items: [{ ...instance(), tenantId: '<default>' }], sortValues: ['10'] },
        { items: [instance('0')], sortValues: ['0'] }, { items: [instance('9223372036854775808')], sortValues: ['9223372036854775808'] }])(
        'rejects malformed or out-of-scope discovery %j', async (page) => {
            const { adapter, post } = http(); const session = await adapter.connect(connection);
            post.mockResolvedValue(response(JSON.stringify(page)));
            await expect(session.searchActiveInstances(definition())).rejects.toThrow(/malformed/);
        });
    test('continues short pages despite total, preserves complete cursors and exact filters', async () => {
        const { adapter, post } = http(); const session = await adapter.connect(connection);
        post.mockResolvedValueOnce(response('{"items":[{"key":9007199254740993,"processDefinitionKey":9223372036854775807,"state":"ACTIVE"}],"sortValues":[9007199254740993,"extra",null],"total":0}'))
            .mockResolvedValueOnce(response('{"items":[]}')).mockResolvedValueOnce(response('', 204));
        const items = await session.searchActiveInstances(definition('9223372036854775807'));
        expect(items[0].key).toBe('9007199254740993');
        expect(post.mock.calls[0][1]).toContain('"processDefinitionKey":9223372036854775807');
        expect(post.mock.calls[0][1]).toContain('"state":"ACTIVE"');
        expect(post.mock.calls[1][1]).toContain('"searchAfter":[9007199254740993,"extra",null]');
        await session.migrate(items[0].key, '9223372036854775807', []);
        expect(post.mock.calls[2][0]).toBe(`${connection.gatewayUrl}/process-instances/9007199254740993/migration`);
        expect(JSON.parse(post.mock.calls[2][1])).toEqual({ targetProcessDefinitionKey: '9223372036854775807', mappingInstructions: [] });
        expect(post.mock.calls[0][2]).toMatchObject({ timeout: 30000, maxRedirects: 0 });
        expect(post.mock.calls[0][2].headers.Authorization).toBeUndefined();
    });
    test.each(['definitions', 'instances'])('guards missing/repeated/regressing cursors for %s', async (kind) => {
        for (const cursor of [undefined, [], ['9'], ['10', {}]]) {
            const { adapter, post } = http(); const session = await adapter.connect(connection);
            const item = kind === 'definitions' ? { ...definition('10'), key: '10' } : instance();
            post.mockResolvedValue(response(JSON.stringify({ items: [item], sortValues: cursor })));
            await expect(kind === 'definitions' ? session.searchDefinitions(entry.processDefinition, 1) : session.searchActiveInstances(definition()))
                .rejects.toThrow(/cursor|malformed/);
        }
        const { adapter, post } = http(); const session = await adapter.connect(connection);
        const item = kind === 'definitions' ? definition('10') : instance();
        post.mockResolvedValue(response(JSON.stringify({ items: [item], sortValues: ['10'] })));
        await expect(kind === 'definitions' ? session.searchDefinitions(entry.processDefinition, 1) : session.searchActiveInstances(definition()))
            .rejects.toThrow(/ascending/);
        expect(post).toHaveBeenCalledTimes(2);
    });
    test.each([401, 403, 404, 409, 500])('sanitizes HTTP %i without retries', async (status) => {
        const { adapter, post } = http(); const session = await adapter.connect(connection);
        post.mockRejectedValue({ isAxiosError: true, response: { status, data: 'secret' }, message: 'dummy-secret' });
        await expect(session.migrate('10', '2', [])).rejects.toThrow(`HTTP ${status}`);
        expect(post).toHaveBeenCalledTimes(1);
    });
    test.each([response('secret malformed'), response('<html>secret</html>', 200), new Error('secret network')])('rejects malformed/network/unexpected status safely', async (result) => {
        const { adapter, post } = http(); const session = await adapter.connect(connection);
        if (result instanceof Error) post.mockRejectedValue(result); else post.mockResolvedValue(result);
        await expect(session.migrate('10', '2', [])).rejects.toThrow(/Process instance migration failed/);
        try { await session.searchDefinitions('id', 1); } catch (error) { expect((error as Error).message).not.toContain('secret'); }
    });
    test('real Axios sends lossless numeric filters/cursors and accepts empty 204', async () => {
        const requests: { url: string; body: string }[] = [];
        const server = createServer((req, res) => {
            let body = ''; req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                requests.push({ url: req.url!, body });
                if (req.url?.endsWith('/migration')) { res.writeHead(204); res.end(); }
                else if (requests.length === 1) res.end('{"items":[{"key":9007199254740993,"state":"ACTIVE","processDefinitionKey":9223372036854775807}],"sortValues":[9007199254740993,null]}');
                else res.end('{"items":[]}');
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            const session = await new AxiosMigrationAdapter(axios.create({ proxy: false })).connect({ gatewayUrl: `${root}/v2`, operateUrl: `${root}/v1` });
            await session.searchActiveInstances(definition('9223372036854775807'));
            await session.migrate('9007199254740993', '9223372036854775807', []);
            expect(requests[0].body).toContain('"processDefinitionKey":9223372036854775807');
            expect(requests[1].body).toContain('"searchAfter":[9007199254740993,null]');
            expect(requests[2]).toEqual({ url: '/v2/process-instances/9007199254740993/migration', body: '{"targetProcessDefinitionKey":"9223372036854775807","mappingInstructions":[]}' });
        } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    });
    test('real Axios refuses redirects and does not retry', async () => {
        let requests = 0;
        const server = createServer((_req, res) => { requests++; res.writeHead(302, { Location: '/secret-destination' }); res.end(); });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            const session = await new AxiosMigrationAdapter(axios.create({ proxy: false })).connect({ gatewayUrl: root, operateUrl: root });
            await expect(session.migrate('10', '2', [])).rejects.toThrow('HTTP 302');
            expect(requests).toBe(1);
        } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    });
});

describe('migration CLI and presentation', () => {
    test('requires exact options, supports optional DI, and forwards JSON', async () => {
        const migrateProcessInstances = jest.fn();
        const cli = createCamundaCli({ migrateProcessInstancesInPort: { migrateProcessInstances } }).exitOverride().configureOutput({ writeErr: () => {} });
        for (const command of cli.commands) command.exitOverride().configureOutput({ writeErr: () => {} });
        await expect(cli.parseAsync(['node', 'cli', 'migrate', '--profile', 'selected'])).rejects.toThrow('migrationPlan');
        const json = JSON.stringify([entry]);
        await cli.parseAsync(['node', 'cli', 'migrate', '--profile', 'selected', '--migrationPlan', json]);
        expect(migrateProcessInstances).toHaveBeenCalledWith({ profile: 'selected', migrationPlan: json });
        await expect(createCamundaCli({}).parseAsync(['node', 'cli', 'migrate', '--profile', 'selected', '--migrationPlan', json])).rejects.toThrow('MigrateProcessInstancesInPort');
    });
    test('escapes ANSI/control/bidi identifiers', () => {
        const write = jest.fn();
        new ConsoleMigrationsPresenter(write).showMigrated('10', { ...migrationPlan([entry])[0], processDefinition: 'id\u001b\n\u202e' });
        expect(write.mock.calls[0][0]).toContain('id\\u001b\\u000a\\u202e');
    });
    test('routes successes and summary to stdout and failures to diagnostics', () => {
        const output = jest.fn(); const diagnostic = jest.fn();
        const presenter = new ConsoleMigrationsPresenter(output, diagnostic);
        presenter.showMigrated('10', migrationPlan([entry])[0]);
        presenter.showFailed('Safe migration failure.');
        presenter.showSummary(1, 2);
        expect(output.mock.calls).toEqual([
            ['Migrated instance 10: processDefinitionId v1 -> v2.'], ['Migrated 1 process instance(s). 2 failed.'],
        ]);
        expect(diagnostic.mock.calls).toEqual([['Safe migration failure.']]);
    });
    test('defaults standalone failure presentation to console.error', () => {
        const diagnostic = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            new ConsoleMigrationsPresenter(jest.fn()).showFailed('Safe migration failure.');
            expect(diagnostic).toHaveBeenCalledWith('Safe migration failure.');
        } finally { diagnostic.mockRestore(); }
    });
    test('bootstrap sends batch failures to injected diagnostics before the next attempt', async () => {
        const home = await fs.mkdtemp(path.join(tmpdir(), 'cli-migrate-'));
        const output = jest.fn(); const diagnostic = jest.fn();
        const events: string[] = [];
        try {
            await new JsonProfileRepositoryAdapter(home).addProfile(local);
            const migrate = jest.fn(async (key: string) => {
                events.push(key);
                if (key === '10') throw new Error('HTTP 401 dummy-secret');
                expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/instance 10 after 0.*HTTP 401/));
            });
            jest.spyOn(AxiosMigrationAdapter.prototype, 'connect').mockResolvedValue({
                searchDefinitions: async (_id, version) => [definition(String(version), version)],
                searchActiveInstances: async () => [instance('10'), instance('11')], migrate,
            });
            await expect(runDefaultCamundaCli(['node', 'cli', 'migrate', '--profile', 'selected', '--migrationPlan', JSON.stringify([entry])],
                { homeDirectory: home, writeLine: output, writeDiagnostic: diagnostic })).rejects.toMatchObject({ successfulCount: 1, failedCount: 1 });
            expect(events).toEqual(['10', '11']);
            expect(diagnostic).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('dummy-secret');
            expect(output.mock.calls).toEqual([
                ['Migrated instance 11: processDefinitionId v1 -> v2.'], ['Migrated 1 process instance(s). 1 failed.'],
            ]);
        } finally { jest.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); }
    });
    test('default runtime uses cached profiles; startup notices go to diagnostics', async () => {
        const home = await fs.mkdtemp(path.join(tmpdir(), 'cli-migrate-'));
        const output = jest.fn(); const diagnostic = jest.fn();
        try {
            await expect(runDefaultCamundaCli(['node', 'cli', 'migrate', '--profile', 'selected', '--migrationPlan', JSON.stringify([entry])],
                { homeDirectory: home, writeLine: output, writeDiagnostic: diagnostic })).rejects.toThrow(/selected profile/);
            expect(output).not.toHaveBeenCalled();
            expect(diagnostic).toHaveBeenCalledWith('Please add a profile with the add profile command.');
            await new JsonProfileRepositoryAdapter(home).addProfile(local);
            const runtime = createDefaultCamundaCli({ homeDirectory: home, writeLine: output });
            await runtime.initialize();
            await fs.writeFile(path.join(home, '.lmoesle-camunda-cli', 'profiles.json'), '{"profiles":[]}');
            const connect = jest.spyOn(AxiosMigrationAdapter.prototype, 'connect').mockResolvedValue({
                searchDefinitions: async (_id, version) => [definition(String(version), version)],
                searchActiveInstances: async () => [], migrate: jest.fn(),
            });
            await runtime.parseAsync(['migrate', '--profile', 'selected', '--migrationPlan', JSON.stringify([entry])], { from: 'user' });
            expect(connect).toHaveBeenCalledWith(connection);
            expect(output).toHaveBeenCalledWith('Migrated 0 process instance(s). 0 failed.');
        } finally { jest.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); }
    });
});
