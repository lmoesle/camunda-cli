import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { AxiosMigrationAdapter, createCamundaCli, createDefaultCamundaCli, JsonProfileRepositoryAdapter,
    LocalMigrationPlanFileAdapter, migrationPlan, MigrationPlanFileOutPort, MigrateProcessInstancesUseCase, Profile } from '../src';

const entry = { processDefinition: ' process ID ', sourceVersion: 'v0001', targetVersion: '2',
    mappingInstructions: [{ sourceElementId: ' old ', targetElementId: ' new ' }] };
const entries = [entry, { ...entry, sourceVersion: 2, targetVersion: 'v3', mappingInstructions: [] }];
const profile: Profile = { name: 'selected', baseUrl: 'http://gateway.example', operateUrl: 'http://operate.example' };

function orchestration(files: MigrationPlanFileOutPort = new LocalMigrationPlanFileAdapter()) {
    const searchDefinitions = jest.fn(async (bpmnProcessId: string, version: number) => [{ key: String(version), version, bpmnProcessId }]);
    const searchActiveInstances = jest.fn(async (source: { key: string }) => [{ key: source.key + '0', processDefinitionKey: source.key, state: 'ACTIVE' }]);
    const migrate = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockResolvedValue({ searchDefinitions, searchActiveInstances, migrate });
    const getProfile = jest.fn(() => profile);
    const presenter = { showMigrated: jest.fn(), showFailed: jest.fn(), showSummary: jest.fn() };
    return { connect, migrate, getProfile, presenter,
        usecase: new MigrateProcessInstancesUseCase({ getProfile }, { connect }, presenter, files) };
}

describe('migration plan JSON or file input', () => {
    let directory: string;
    beforeEach(async () => { directory = await fs.mkdtemp(path.join(tmpdir(), 'cli-plan-')); });
    afterEach(async () => { jest.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

    test('inline JSON, parsed arrays and pretty-printed files execute the same normalized plan', async () => {
        const filename = path.join(directory, ' migration plan 日本語.json ');
        await fs.writeFile(filename, JSON.stringify(entries, null, 2) + '\n');
        for (const input of [entries, JSON.stringify(entries), filename, path.relative(process.cwd(), filename)]) {
            const state = orchestration();
            await state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: input });
            expect(state.connect).toHaveBeenCalledTimes(1);
            expect(state.migrate.mock.calls).toEqual([
                ['10', '2', entry.mappingInstructions], ['20', '3', []],
            ]);
            expect(state.presenter.showMigrated).toHaveBeenNthCalledWith(1, '10', migrationPlan(entries)[0]);
            expect(state.presenter.showSummary).toHaveBeenCalledWith(2, 0);
        }
    });

    test('continues into later entries from a file after a migration failure', async () => {
        const filename = path.join(directory, 'plan.json');
        await fs.writeFile(filename, JSON.stringify(entries, null, 2));
        const state = orchestration();
        state.migrate.mockRejectedValueOnce(new Error('HTTP 409 dummy-secret'));
        await expect(state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: filename }))
            .rejects.toMatchObject({ successfulCount: 1, failedCount: 1 });
        expect(state.migrate.mock.calls).toEqual([
            ['10', '2', entry.mappingInstructions], ['20', '3', []],
        ]);
        expect(state.presenter.showFailed).toHaveBeenCalledTimes(1);
        expect(state.presenter.showFailed).toHaveBeenCalledWith(expect.stringMatching(/instance 10 after 0.*HTTP 409/));
        expect(JSON.stringify(state.presenter.showFailed.mock.calls)).not.toContain('dummy-secret');
        expect(state.presenter.showMigrated).toHaveBeenCalledTimes(1);
        expect(state.presenter.showMigrated).toHaveBeenCalledWith('20', migrationPlan(entries)[1]);
        expect(state.presenter.showSummary).toHaveBeenCalledTimes(1);
        expect(state.presenter.showSummary).toHaveBeenCalledWith(1, 1);
    });

    test.each(['{}', '[]', 'null', 'true', 'false', '12', '"filename.json"', ' ', '\n',
        '[{"dummy-secret":', '{broken dummy-secret'])('valid JSON or malformed array/object inline input %j never reads a file', async (input) => {
        const read = jest.fn();
        const state = orchestration({ read });
        const result = state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: input });
        await expect(result).rejects.toThrow(/Migration plan/);
        await expect(result).rejects.not.toThrow('dummy-secret');
        expect(read).not.toHaveBeenCalled();
        expect(state.getProfile).not.toHaveBeenCalled();
        expect(state.connect).not.toHaveBeenCalled();
    });

    test('passes exact non-JSON filenames to the port and completes reading before profile lookup', async () => {
        const read = jest.fn(async () => {
            expect(state.getProfile).not.toHaveBeenCalled();
            expect(state.connect).not.toHaveBeenCalled();
            return JSON.stringify(entries);
        });
        const state = orchestration({ read });
        await state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: ' plan 日本語.json ' });
        expect(read).toHaveBeenCalledWith(' plan 日本語.json ');
    });

    test('explicit relative paths disambiguate JSON-like filenames', async () => {
        const read = jest.fn().mockResolvedValue(JSON.stringify(entries));
        const state = orchestration({ read });
        for (const filename of ['./null', './[]', './{broken']) {
            await state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: filename });
            expect(read).toHaveBeenLastCalledWith(filename);
        }
    });

    test.each([
        { content: '', diagnostic: 'valid JSON' },
        { content: '[{"dummy-secret":', diagnostic: 'valid JSON' },
        { content: '[]', diagnostic: 'nonempty array' },
        { content: '{}', diagnostic: 'nonempty array' },
        { content: '"another-plan.json"', diagnostic: 'nonempty array' },
        { content: JSON.stringify([{ ...entry, dummySecret: 'dummy-secret' }]), diagnostic: 'entry 0: invalid fields' },
        { content: JSON.stringify([entry, { ...entry, sourceVersion: 'dummy-secret' }]), diagnostic: 'entry 1: invalid sourceVersion' },
    ])('rejects invalid file contents before profile lookup or connection ($diagnostic)', async ({ content, diagnostic }) => {
        const filename = path.join(directory, 'plan.json');
        await fs.writeFile(filename, content);
        const read = jest.spyOn(LocalMigrationPlanFileAdapter.prototype, 'read');
        const state = orchestration();
        const result = state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: filename });
        await expect(result).rejects.toThrow(diagnostic);
        await expect(result).rejects.not.toThrow('dummy-secret');
        expect(read).toHaveBeenCalledTimes(1);
        expect(state.getProfile).not.toHaveBeenCalled();
        expect(state.connect).not.toHaveBeenCalled();
        expect(state.migrate).not.toHaveBeenCalled();
    });

    test.each(['missing', 'directory', 'symlink', 'unreadable'])('rejects a %s file safely before connecting', async (kind) => {
        const filename = path.join(directory, 'plan.json');
        if (kind === 'directory') await fs.mkdir(filename);
        if (kind === 'symlink') {
            const target = path.join(directory, 'target.json');
            await fs.writeFile(target, JSON.stringify(entries));
            await fs.symlink(target, filename);
        }
        if (kind === 'unreadable') {
            await fs.writeFile(filename, JSON.stringify(entries));
            jest.spyOn(fs, 'open').mockRejectedValueOnce(Object.assign(new Error('dummy-secret filesystem cause'), { code: 'EACCES' }));
        }
        const state = orchestration();
        const result = state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: filename });
        await expect(result).rejects.toThrow(/Cannot read migration plan file.*readable regular non-symlink file/);
        await expect(result).rejects.not.toThrow('dummy-secret');
        expect(state.connect).not.toHaveBeenCalled();
        expect(state.migrate).not.toHaveBeenCalled();
    });

    test('rejects special files without opening or waiting on them', async () => {
        const filename = path.join(directory, 'socket');
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(filename, resolve));
        try {
            const open = jest.spyOn(fs, 'open');
            const state = orchestration();
            await expect(state.usecase.migrateProcessInstances({ profile: 'selected', migrationPlan: filename }))
                .rejects.toThrow('Cannot read migration plan file.');
            expect(open).not.toHaveBeenCalled();
            expect(state.connect).not.toHaveBeenCalled();
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    test('CLI forwards a raw path unchanged and advertises both input forms', async () => {
        const migrateProcessInstances = jest.fn();
        const cli = createCamundaCli({
            migrateProcessInstancesInPort: { migrateProcessInstances },
        });
        const filename = './ migration plan 日本語.json ';
        await cli.parseAsync(['migrate', '--profile', 'selected', '--migrationPlan', filename], { from: 'user' });
        expect(migrateProcessInstances).toHaveBeenCalledWith({ profile: 'selected', migrationPlan: filename });
        expect(cli.commands.find((command) => command.name() === 'migrate')?.helpInformation()).toContain('<json-or-path>');
    });

    test('default runtime loads files and rejects bad contents without authenticating', async () => {
        await new JsonProfileRepositoryAdapter(directory).addProfile(profile);
        const filename = path.join(directory, 'plan.json');
        await fs.writeFile(filename, JSON.stringify(entries));
        const connect = jest.spyOn(AxiosMigrationAdapter.prototype, 'connect').mockResolvedValue({
            searchDefinitions: async (bpmnProcessId, version) => [{ key: String(version), bpmnProcessId, version }],
            searchActiveInstances: async () => [], migrate: jest.fn(),
        });
        const output = jest.fn();
        const cli = createDefaultCamundaCli({ homeDirectory: directory, writeLine: output });
        const argv = ['migrate', '--profile', 'selected', '--migrationPlan', filename];
        await cli.parseAsync(argv, { from: 'user' });
        expect(connect).toHaveBeenCalledTimes(1);
        expect(output).toHaveBeenCalledWith('Migrated 0 process instance(s). 0 failed.');
        connect.mockClear();
        await fs.writeFile(filename, 'dummy-secret malformed JSON');
        await expect(cli.parseAsync(argv, { from: 'user' })).rejects.toThrow('Migration plan must be valid JSON.');
        expect(connect).not.toHaveBeenCalled();
    });
});
