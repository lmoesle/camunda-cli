import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createCamundaCli, createDefaultCamundaCli, runDefaultCamundaCli, CreateMigrationBundleUseCase,
    LocalMigrationBundleFilesAdapter, LocalMigrationPlanFileAdapter, migrationPlan, MigrateProcessInstancesUseCase } from '../src';

const entry = (sourceVersion: number | string, processDefinition = 'order-process') => ({
    processDefinition, sourceVersion, targetVersion: 'v10', mappingInstructions: [],
});

describe('create migration bundle', () => {
    let directory: string;
    let source: string;
    let target: string;
    const usecase = () => new CreateMigrationBundleUseCase(new LocalMigrationBundleFilesAdapter(), new LocalMigrationPlanFileAdapter());
    const planFile = (name: string, entries: unknown = [entry(1)]) => fs.writeFile(path.join(source, name), JSON.stringify(entries));

    beforeEach(async () => {
        directory = await fs.mkdtemp(path.join(tmpdir(), 'cli-bundle-'));
        source = path.join(directory, 'plans');
        target = path.join(source, 'bundled-migrations.json');
        await fs.mkdir(source);
    });
    afterEach(async () => { jest.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

    test('requires sourceDir before dispatch and accepts no profile flag', async () => {
        const createMigrationBundle = jest.fn();
        const program = createCamundaCli({ createMigrationBundleInPort: { createMigrationBundle } });
        program.exitOverride().configureOutput({ writeErr: () => undefined });
        program.commands.forEach((command) => command.exitOverride().configureOutput({ writeErr: () => undefined }));
        await expect(program.parseAsync(['create-migration-bundle'], { from: 'user' }))
            .rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
        expect(createMigrationBundle).not.toHaveBeenCalled();
        await program.parseAsync(['create-migration-bundle', '--sourceDir', ' plans '], { from: 'user' });
        expect(createMigrationBundle).toHaveBeenCalledWith({ sourceDir: ' plans ' });
    });

    test('default runtime flattens nested arrays in sorted file order, normalizes versions and supports reruns', async () => {
        await fs.mkdir(path.join(source, 'nested'));
        await planFile('z.json', [entry(4)]);
        await planFile('nested/b.json', [entry('v003')]);
        await planFile('a.json', [entry('v001'), entry('2')]);
        await fs.writeFile(path.join(source, 'ignored.txt'), 'bad input');
        await fs.writeFile(path.join(source, 'ignored.JSON'), 'bad input');
        const cli = createDefaultCamundaCli({ homeDirectory: path.join(directory, 'home'), writeLine: jest.fn(), writeDiagnostic: jest.fn() });
        const argv = ['create-migration-bundle', '--sourceDir', path.relative(process.cwd(), source)];
        await cli.parseAsync(argv, { from: 'user' });
        const contents = await fs.readFile(target, 'utf8');
        expect(migrationPlan(contents)).toEqual([entry(1), entry(2), entry(3), entry(4)].map((item) => ({ ...item, targetVersion: 10 })));
        expect(contents.endsWith('\n')).toBe(true);
        await cli.parseAsync(argv, { from: 'user' });
        expect(await fs.readFile(target, 'utf8')).toBe(contents);

        // The generated file is accepted by the existing migrate file-input flow.
        const searchDefinitions = jest.fn(async (bpmnProcessId: string, version: number) => [{ key: String(version), bpmnProcessId, version }]);
        const connect = jest.fn().mockResolvedValue({ searchDefinitions, searchActiveInstances: async () => [], migrate: jest.fn() });
        const migrate = new MigrateProcessInstancesUseCase({ getProfile: () => ({ name: 'dummy', baseUrl: 'http://dummy.example', operateUrl: 'http://dummy.example' }) },
            { connect }, { showMigrated: jest.fn(), showFailed: jest.fn(), showSummary: jest.fn() }, new LocalMigrationPlanFileAdapter());
        await migrate.migrateProcessInstances({ profile: 'dummy', migrationPlan: target });
        expect(connect).toHaveBeenCalledTimes(1);
        expect(searchDefinitions).toHaveBeenCalledWith('order-process', 4);
    });

    test.each(['inside', 'outside'])('custom %s target resolves from cwd, overwrites and excludes output on reruns', async (location) => {
        await planFile('a.json');
        target = path.join(location === 'inside' ? source : directory, 'custom.json');
        await fs.writeFile(target, 'old output');
        const command = { sourceDir: source, target: path.relative(process.cwd(), target) };
        await usecase().createMigrationBundle(command);
        const contents = await fs.readFile(target, 'utf8');
        await usecase().createMigrationBundle(command);
        expect(await fs.readFile(target, 'utf8')).toBe(contents);
        expect(migrationPlan(contents)).toHaveLength(1);
    });

    test('excludes target through a symlinked parent alias', async () => {
        await planFile('a.json');
        const alias = path.join(directory, 'alias');
        await fs.symlink(source, alias);
        await fs.writeFile(target, 'old output');
        await usecase().createMigrationBundle({ sourceDir: source, target: path.join(alias, path.basename(target)) });
        expect(migrationPlan(await fs.readFile(target, 'utf8'))).toHaveLength(1);
    });

    test.each([
        ['invalid JSON', '[{"dummy-secret":', 'valid JSON'],
        ['empty array', '[]', 'nonempty array'],
        ['invalid schema', JSON.stringify([{ ...entry(1), secret: 'dummy-secret' }]), 'invalid fields'],
        ['duplicate within file', JSON.stringify([entry(1), entry('v1')]), 'duplicate source selector'],
    ])('%s fails with sanitized diagnostics and preserves output', async (_name, contents, diagnostic) => {
        await fs.writeFile(target, 'existing output');
        await fs.writeFile(path.join(source, 'bad\nfile.json'), contents);
        const result = usecase().createMigrationBundle({ sourceDir: source });
        await expect(result).rejects.toThrow(diagnostic);
        await expect(result).rejects.toThrow('bad\\u000afile.json');
        await expect(result).rejects.not.toThrow('dummy-secret');
        expect(await fs.readFile(target, 'utf8')).toBe('existing output');
        expect((await fs.readdir(source)).sort()).toEqual(['bad\nfile.json', 'bundled-migrations.json']);
    });

    test('duplicates across files are rejected after normalization before any write', async () => {
        await planFile('a.json', [entry(1)]);
        await planFile('b.json', [entry('v0001')]);
        await fs.writeFile(target, 'existing output');
        await expect(usecase().createMigrationBundle({ sourceDir: source })).rejects.toThrow('duplicate source selector');
        expect(await fs.readFile(target, 'utf8')).toBe('existing output');
    });

    test('invalid input never creates an absent output', async () => {
        await planFile('a.json', {});
        await expect(usecase().createMigrationBundle({ sourceDir: source })).rejects.toThrow('nonempty array');
        expect(await fs.readdir(source)).toEqual(['a.json']);
    });

    test('rechecks target safety after reading and validation', async () => {
        await planFile('a.json');
        const reader = { read: async (filename: string) => {
            const contents = await new LocalMigrationPlanFileAdapter().read(filename);
            await fs.symlink(filename, target);
            return contents;
        } };
        const bundle = new CreateMigrationBundleUseCase(new LocalMigrationBundleFilesAdapter(), reader);
        await expect(bundle.createMigrationBundle({ sourceDir: source })).rejects.toThrow('Cannot write migration bundle');
        expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
        expect(await fs.readdir(source)).toEqual(['a.json', 'bundled-migrations.json']);
    });

    test('skips symlink files and directories, including cycles and broken links', async () => {
        await planFile('a.json');
        await fs.symlink(path.join(source, 'a.json'), path.join(source, 'linked.json'));
        await fs.symlink(source, path.join(source, 'cycle'));
        await fs.symlink(path.join(directory, 'missing'), path.join(source, 'broken.json'));
        await usecase().createMigrationBundle({ sourceDir: source });
        expect(migrationPlan(await fs.readFile(target, 'utf8'))).toHaveLength(1);
    });

    test('no input (including only an existing output) fails without changing output', async () => {
        await expect(usecase().createMigrationBundle({ sourceDir: source })).rejects.toThrow('No input');
        await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
        await fs.writeFile(target, 'existing output');
        await expect(usecase().createMigrationBundle({ sourceDir: source })).rejects.toThrow('No input');
        expect(await fs.readFile(target, 'utf8')).toBe('existing output');
    });

    test.each(['missing', 'file', 'symlink', 'blank'])('rejects %s source directory', async (kind) => {
        let input = path.join(directory, 'input');
        if (kind === 'file') await fs.writeFile(input, 'data');
        if (kind === 'symlink') await fs.symlink(source, input);
        if (kind === 'blank') input = ' ';
        await expect(usecase().createMigrationBundle({ sourceDir: input })).rejects.toThrow('sourceDir');
    });

    test.each(['/', '/.'])('rejects a source directory symlink ending with %s without changing output', async (suffix) => {
        await planFile('a.json');
        await fs.writeFile(target, 'existing output');
        const link = path.join(directory, 'linked-source');
        await fs.symlink(source, link);
        await expect(usecase().createMigrationBundle({ sourceDir: link + suffix })).rejects.toThrow('sourceDir');
        expect(await fs.readFile(target, 'utf8')).toBe('existing output');
        expect((await fs.readdir(source)).sort()).toEqual(['a.json', 'bundled-migrations.json']);
    });

    test.each(['directory', 'symlink', 'missing parent', 'blank'])('rejects %s target without modifying inputs', async (kind) => {
        await planFile('a.json');
        if (kind === 'directory') await fs.mkdir(target);
        if (kind === 'symlink') await fs.symlink(path.join(source, 'a.json'), target);
        if (kind === 'missing parent') target = path.join(directory, 'missing', 'output.json');
        if (kind === 'blank') target = ' ';
        await expect(usecase().createMigrationBundle({ sourceDir: source, target })).rejects.toThrow('existing directory');
        expect(migrationPlan(await fs.readFile(path.join(source, 'a.json'), 'utf8'))).toHaveLength(1);
    });

    test('rejects a special-file target without opening it', async () => {
        await planFile('a.json');
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(target, resolve));
        try {
            const open = jest.spyOn(fs, 'open');
            await expect(usecase().createMigrationBundle({ sourceDir: source })).rejects.toThrow('regular non-symlink');
            expect(open).not.toHaveBeenCalled();
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    test.each(['discover', 'read', 'open', 'write', 'rename'])('%s filesystem failure is sanitized and preserves output without temporary files', async (stage) => {
        await planFile('a.json');
        await fs.writeFile(target, 'existing output');
        const error = Object.assign(new Error('dummy-secret filesystem cause'), { code: 'EACCES' });
        if (stage === 'discover') jest.spyOn(fs, 'readdir').mockRejectedValueOnce(error);
        if (stage === 'read') jest.spyOn(LocalMigrationPlanFileAdapter.prototype, 'read').mockImplementationOnce(async () => {
            jest.spyOn(fs, 'open').mockRejectedValueOnce(error);
            return new LocalMigrationPlanFileAdapter().read(path.join(source, 'a.json'));
        });
        if (stage === 'open') {
            const realOpen = fs.open;
            jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
                if (args[1] === 'wx') throw error;
                return realOpen(...args);
            });
        }
        if (stage === 'write') {
            const realOpen = fs.open;
            jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
                const file = await realOpen(...args);
                if (args[1] === 'wx') jest.spyOn(file, 'writeFile').mockRejectedValueOnce(error);
                return file;
            });
        }
        if (stage === 'rename') jest.spyOn(fs, 'rename').mockRejectedValueOnce(error);
        const result = usecase().createMigrationBundle({ sourceDir: source });
        await expect(result).rejects.toThrow(/Cannot/);
        await expect(result).rejects.not.toThrow('dummy-secret');
        expect(await fs.readFile(target, 'utf8')).toBe('existing output');
        expect((await fs.readdir(source)).sort()).toEqual(['a.json', 'bundled-migrations.json']);
    });

    test('entry point routes startup notice to diagnostics without requiring a stored profile', async () => {
        await planFile('a.json');
        const writeLine = jest.fn();
        const writeDiagnostic = jest.fn();
        await runDefaultCamundaCli(['node', 'camunda-cli', 'create-migration-bundle', '--sourceDir', source], {
            homeDirectory: path.join(directory, 'empty-home'), writeLine, writeDiagnostic,
        });
        expect(writeLine).not.toHaveBeenCalled();
        expect(writeDiagnostic).toHaveBeenCalledTimes(1);
        expect(migrationPlan(await fs.readFile(target, 'utf8'))).toHaveLength(1);
    });
});
