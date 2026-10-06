import axios, { AxiosInstance } from 'axios';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { AxiosMigrationAdapter, MigrateProcessInstancesUseCase, MigrationBatchFailure, MigrationPlanEntry, MissingMigrationElement, Profile } from '../src';

const key = '2251799945862523';
const plan: MigrationPlanEntry = { processDefinition: 'Process_SendCrmMailToCustomer', sourceVersion: 9, targetVersion: 11,
    mappingInstructions: [{ sourceElementId: 'gateway_mailDispatch', targetElementId: 'gateway_newDispatch' },
        { sourceElementId: 'other_missing', targetElementId: 'other_target' }] };
const profile: Profile = { name: 'dummy', baseUrl: 'http://gateway.example/v2', operateUrl: 'http://operate.example/v1' };
// Literal, source-derived Camunda 8.7 fixtures, not captured cluster responses.
const sourceDetail = "Command 'MIGRATE' rejected with code 'INVALID_ARGUMENT': Expected to migrate process instance '2251799945862523' but mapping instructions contain a non-existing source element id 'gateway_mailDispatch'. Elements provided in mapping instructions must exist in the source process definition.";
const targetDetail = "Command 'MIGRATE' rejected with code 'INVALID_ARGUMENT': Expected to migrate process instance '2251799945862523' but mapping instructions contain a non-existing target element id 'gateway_newDispatch'. Elements provided in mapping instructions must exist in the target process definition.";
const problem = (detail = sourceDetail) => ({ type: 'about:blank', title: 'INVALID_ARGUMENT', status: 400, detail });

function setup(body: unknown, status: number | undefined = 400, entry = plan, keys = [key]) {
    const migrate = jest.fn().mockRejectedValue({ isAxiosError: true, message: 'dummy-secret', response: status === undefined ? undefined : { status, data: body } });
    const post = jest.fn(async (url: string, data: string) => {
        if (url.endsWith('/migration')) return migrate(url, data);
        const request = JSON.parse(data) as { filter: { version?: number }; searchAfter?: unknown[] };
        if (request.searchAfter) return { status: 200, data: '{"items":[]}' };
        const items = url.includes('process-definitions')
            ? [{ key: String(request.filter.version), bpmnProcessId: entry.processDefinition, version: request.filter.version }]
            : keys.map((instanceKey) => ({ key: instanceKey, processDefinitionKey: '9', state: 'ACTIVE' }));
        return { status: 200, data: JSON.stringify({ items, sortValues: [items[items.length - 1].key] }) };
    });
    const presenter = { showMigrated: jest.fn(), showFailed: jest.fn(), showSummary: jest.fn() };
    const usecase = new MigrateProcessInstancesUseCase({ getProfile: () => profile },
        new AxiosMigrationAdapter({ post } as unknown as AxiosInstance), presenter);
    return { post, migrate, presenter, run: () => usecase.migrateProcessInstances({ profile: 'dummy', migrationPlan: [entry] }) };
}

describe('safe migration rejection diagnostics', () => {
    test.each([JSON.stringify(problem()), 'dummy-secret'])('does not retain private Axios fields at either public error boundary (%#)', async (body) => {
        const rejection = { isAxiosError: true, message: 'dummy-secret',
            cause: new Error('dummy-secret'), config: { headers: { Authorization: 'dummy-token' } },
            response: { status: 400, data: body }, data: 'dummy-secret' };
        const post = jest.fn().mockRejectedValue(rejection);
        const adapter = new AxiosMigrationAdapter({ post } as unknown as AxiosInstance);
        const session = await adapter.connect({ gatewayUrl: profile.baseUrl!, operateUrl: profile.operateUrl! });
        const adapterFailure = session.migrate(key, '11', plan.mappingInstructions);
        const state = setup(body);
        state.migrate.mockRejectedValue(rejection);
        const publicFailure = state.run();
        await expect(adapterFailure).rejects.toThrow(/HTTP 400/);
        await expect(publicFailure).rejects.toBeInstanceOf(MigrationBatchFailure);
        for (const failure of [adapterFailure, publicFailure]) {
            await expect(failure).rejects.not.toThrow(/dummy-secret|dummy-token/);
            for (const field of ['cause', 'config', 'response', 'data']) {
                await expect(failure).rejects.not.toHaveProperty(field);
            }
        }
        expect(state.presenter.showFailed).toHaveBeenCalledWith(expect.stringContaining('HTTP 400'));
        expect(JSON.stringify(state.presenter.showFailed.mock.calls)).not.toMatch(/dummy-secret|dummy-token|Authorization|config|response/);
    });

    test.each([
        { side: 'source', detail: sourceDetail, id: 'gateway_mailDispatch', version: 9, other: 'target version 11' },
        { side: 'target', detail: targetDetail, id: 'gateway_newDispatch', version: 11, other: 'source version 9' },
    ])('reports the missing $side element with local plan context', async ({ side, detail, id, version, other }) => {
        const state = setup(JSON.stringify(problem(detail)));
        await expect(state.run()).rejects.toMatchObject({ successfulCount: 0, failedCount: 1 });
        expect(state.presenter.showFailed).toHaveBeenCalledWith(expect.stringContaining(`Invalid migrationPlan for process '${plan.processDefinition}': ${side}ElementId '${id}' does not exist in ${side} version ${version} (${other}). Check every ${side}ElementId against version ${version}; Camunda reports only the first invalid mapping.`));
        expect(state.migrate).toHaveBeenCalledTimes(1);
        expect(state.presenter.showSummary).toHaveBeenCalledWith(0, 1);
    });

    test('continues after multiple failures, preserves one success, and reports only the rejected mapping', async () => {
        const state = setup(JSON.stringify(problem()), 400, plan, ['2251799945862522', key, '2251799945862524']);
        state.migrate.mockResolvedValueOnce({ status: 204, data: '' });
        const failure = state.run();
        await expect(failure).rejects.toMatchObject({ successfulCount: 1, failedCount: 2 });
        expect(state.presenter.showFailed).toHaveBeenCalledTimes(2);
        expect(state.presenter.showFailed).toHaveBeenNthCalledWith(1, expect.stringContaining(`instance ${key} after 1 successful migrations (HTTP 400)`));
        expect(state.presenter.showFailed).toHaveBeenNthCalledWith(1, expect.stringContaining('sourceElementId'));
        expect(JSON.stringify(state.presenter.showFailed.mock.calls)).not.toContain('other_missing');
        expect(state.migrate).toHaveBeenCalledTimes(3);
        expect(state.presenter.showMigrated).toHaveBeenCalledTimes(1);
        expect(state.presenter.showSummary).toHaveBeenCalledTimes(1);
        expect(state.presenter.showSummary).toHaveBeenCalledWith(1, 2);
    });

    test.each([
        'dummy-secret', '<html>dummy-secret</html>', '{bad JSON', '[]', 'null',
        JSON.stringify({ ...problem(), title: 'dummy-secret' }),
        JSON.stringify({ ...problem(), status: 409 }),
        JSON.stringify({ ...problem(), status: '400' }),
        JSON.stringify({ ...problem(), type: [] }),
        JSON.stringify({ ...problem(), instance: {} }),
        JSON.stringify({ ...problem(), detail: 123 }),
        JSON.stringify(problem(sourceDetail.replace(key, '99'))),
        JSON.stringify(problem(sourceDetail.replace('gateway_mailDispatch', 'dummy-secret'))),
        JSON.stringify(problem(sourceDetail + ' dummy-secret')),
        JSON.stringify(problem('All [sourceElementId, targetElementId] are required. dummy-secret')),
        JSON.stringify({ ...problem(), padding: 'dummy-secret'.repeat(7000) }),
        { ...problem(), secret: 'dummy-secret' },
    ])('falls back safely for unrecognized bodies (%#)', async (body) => {
        const state = setup(body); const failure = state.run();
        await expect(failure).rejects.toBeInstanceOf(MigrationBatchFailure);
        expect(state.presenter.showFailed).toHaveBeenCalledWith(expect.stringMatching(/HTTP 400.*uncertain/));
        expect(JSON.stringify(state.presenter.showFailed.mock.calls)).not.toMatch(/Invalid migrationPlan|dummy-secret/);
        await expect(failure).rejects.not.toThrow(/Invalid migrationPlan|dummy-secret/);
    });

    test.each([401, 403, 409, 500])('never classifies HTTP %i as a missing element', async (status) => {
        const state = setup(JSON.stringify(problem()), status); const failure = state.run();
        await expect(failure).rejects.toBeInstanceOf(MigrationBatchFailure);
        expect(state.presenter.showFailed).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${status}`));
        expect(JSON.stringify(state.presenter.showFailed.mock.calls)).not.toMatch(/Invalid migrationPlan|dummy-secret/);
        await expect(failure).rejects.not.toThrow(/Invalid migrationPlan|dummy-secret/);
    });
    test('network errors retain the safe uncertain-outcome warning', async () => {
        const state = setup(''); state.migrate.mockRejectedValue(new Error('dummy-secret network'));
        const failure = state.run();
        await expect(failure).rejects.toBeInstanceOf(MigrationBatchFailure);
        expect(state.presenter.showFailed).toHaveBeenCalledWith(expect.stringContaining('outcome may be uncertain'));
        expect(JSON.stringify(state.presenter.showFailed.mock.calls)).not.toMatch(/Invalid migrationPlan|dummy-secret/);
        await expect(failure).rejects.not.toThrow(/Invalid migrationPlan|dummy-secret/);
    });
    test('ignores unrelated problem fields even on recognized rejections', async () => {
        const state = setup(JSON.stringify({ ...problem(), headers: { Authorization: 'dummy-secret' }, instance: 'dummy-secret' }));
        const failure = state.run();
        await expect(failure).rejects.toBeInstanceOf(MigrationBatchFailure);
        expect(state.presenter.showFailed).toHaveBeenCalledWith(expect.stringContaining('sourceElementId'));
        expect(JSON.stringify(state.presenter.showFailed.mock.calls)).not.toContain('dummy-secret');
        await expect(failure).rejects.not.toThrow('dummy-secret');
    });
    test('title and detail suffice without optional problem fields', async () => {
        const state = setup(JSON.stringify({ title: 'INVALID_ARGUMENT', detail: sourceDetail }));
        await expect(state.run()).rejects.toBeInstanceOf(MigrationBatchFailure);
        expect(state.presenter.showFailed).toHaveBeenCalledWith(expect.stringContaining('sourceElementId'));
    });
    test.each(['OAuth', 'discovery'])('does not classify a rejection from %s as migration validation', async (stage) => {
        const post = jest.fn().mockRejectedValue({ isAxiosError: true, response: { status: 400, data: JSON.stringify(problem()) } });
        const adapter = new AxiosMigrationAdapter({ post } as unknown as AxiosInstance);
        const failure = stage === 'OAuth'
            ? adapter.connect({ gatewayUrl: profile.baseUrl!, operateUrl: profile.operateUrl!, oauth: { clientId: 'dummy', clientSecret: 'dummy-secret', oAuthUrl: 'http://auth.example' } })
            : adapter.connect({ gatewayUrl: profile.baseUrl!, operateUrl: profile.operateUrl! }).then((session) => session.searchDefinitions(plan.processDefinition, 9));
        await expect(failure).rejects.toThrow('HTTP 400');
        await expect(failure).rejects.not.toThrow(/Invalid migrationPlan|non-existing|dummy-secret/);
    });
    test('escapes local quotes, controls and bidi and bounds long displayed identifiers', async () => {
        const id = "quoted'\\\u001b\n\u202e\u061c\u200e\u200f" + 'x'.repeat(5000);
        const entry = { ...plan, processDefinition: id, mappingInstructions: [{ sourceElementId: id, targetElementId: 'target' }] };
        const detail = sourceDetail.replace('gateway_mailDispatch', id);
        const state = setup(JSON.stringify(problem(detail)), 400, entry);
        await expect(state.run()).rejects.toBeInstanceOf(MigrationBatchFailure);
        expect(state.presenter.showFailed).toHaveBeenCalledTimes(1);
        const message = state.presenter.showFailed.mock.calls[0][0] as string;
        expect(message).toContain('Invalid migrationPlan');
        expect(message).toContain("quoted\\'\\\\\\u001b\\u000a\\u202e\\u061c\\u200e\\u200f");
        // eslint-disable-next-line no-control-regex -- assert no literal terminal controls survive
        expect(message).not.toMatch(/[\u001b\n\u202e\u061c\u200e\u200f]/);
        expect(message.length).toBeLessThan(1500);
    });
    test('external adapters can supply safe typed evidence without their arbitrary error message leaking', async () => {
        const rejection = new MissingMigrationElement('target', 1);
        rejection.message = 'dummy-secret';
        Object.assign(rejection, { cause: new Error('dummy-secret'), config: { token: 'dummy-secret' },
            response: { data: 'dummy-secret' }, data: 'dummy-secret' });
        const presenter = { showMigrated: jest.fn(), showFailed: jest.fn(), showSummary: jest.fn() };
        const usecase = new MigrateProcessInstancesUseCase({ getProfile: () => profile }, { connect: async () => ({
            searchDefinitions: async (id, version) => [{ key: String(version), version, bpmnProcessId: id }],
            searchActiveInstances: async () => [{ key, processDefinitionKey: '9', state: 'ACTIVE' }],
            migrate: async () => { throw rejection; },
        }) }, presenter);
        const failure = usecase.migrateProcessInstances({ profile: 'dummy', migrationPlan: [plan] });
        await expect(failure).rejects.toBeInstanceOf(MigrationBatchFailure);
        expect(presenter.showFailed).toHaveBeenCalledWith(expect.stringContaining("targetElementId 'other_target' does not exist in target version 11"));
        expect(JSON.stringify(presenter.showFailed.mock.calls)).not.toMatch(/dummy-secret|config|response/);
        await expect(failure).rejects.not.toThrow('dummy-secret');
        for (const field of ['cause', 'config', 'response', 'data']) {
            await expect(failure).rejects.not.toHaveProperty(field);
        }
        expect(() => new MissingMigrationElement('source', -1)).toThrow('Invalid missing migration element evidence');
        expect(new MissingMigrationElement('source', 99).diagnostic(plan)).toBeUndefined();
    });
    test('real Axios text problem response reaches the full usecase diagnostic', async () => {
        let migrations = 0;
        const server = createServer((req, res) => {
            let body = ''; req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                if (req.url?.endsWith('/migration')) {
                    migrations++; res.writeHead(400, { 'Content-Type': 'application/problem+json' }); res.end(JSON.stringify(problem())); return;
                }
                const request = JSON.parse(body) as { filter: { version?: number }; searchAfter?: unknown[] };
                const items = request.searchAfter ? [] : req.url?.includes('process-definitions')
                    ? [{ key: String(request.filter.version), version: request.filter.version, bpmnProcessId: plan.processDefinition }]
                    : [{ key, processDefinitionKey: '9', state: 'ACTIVE' }];
                res.end(JSON.stringify({ items, sortValues: [items[0]?.key] }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            const presenter = { showMigrated: jest.fn(), showFailed: jest.fn(), showSummary: jest.fn() };
            const usecase = new MigrateProcessInstancesUseCase({ getProfile: () => ({ ...profile, baseUrl: root, operateUrl: root }) },
                new AxiosMigrationAdapter(axios.create({ proxy: false })), presenter);
            await expect(usecase.migrateProcessInstances({ profile: 'dummy', migrationPlan: [plan] })).rejects.toBeInstanceOf(MigrationBatchFailure);
            expect(presenter.showFailed).toHaveBeenCalledWith(expect.stringContaining(
                "sourceElementId 'gateway_mailDispatch' does not exist in source version 9 (target version 11)"));
            expect(migrations).toBe(1); expect(presenter.showSummary).toHaveBeenCalledWith(0, 1);
        } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    });
});
