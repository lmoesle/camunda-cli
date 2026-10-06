import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('migration executable error boundary', () => {
    test('drains backpressured stdout and stderr before a failed batch exits', async () => {
        const home = await fs.mkdtemp(path.join(tmpdir(), 'cli-migration-pipes-'));
        const size = 2 * 1024 * 1024;
        const summary = 'Migrated 1 process instance(s). 1 failed.';
        // Load current sources, not dist. Replace only bootstrap; execute the real bin handler and batch error class.
        const script = `
            const fs = require('node:fs');
            const Module = require('node:module');
            const ts = require(${JSON.stringify(require.resolve('typescript'))});
            require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(
                fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
            ).outputText, filename);
            const { MigrationBatchFailure } = require(${JSON.stringify(path.resolve(__dirname, '../src/domain/migration.ts'))});
            const load = Module._load;
            Module._load = function(request, ...args) {
                if (request === '../bootstrap/camundaCli') return { runDefaultCamundaCli: async () => {
                    console.log('S'.repeat(${size}));
                    console.error('D'.repeat(${size}));
                    console.log(${JSON.stringify(summary)});
                    await new Promise((resolve, reject) => process.send({ pressure: true,
                        stdoutPending: process.stdout.writableLength, stderrPending: process.stderr.writableLength
                    }, error => error ? reject(error) : resolve()));
                    // This runs after the handler's rejection microtask, unless process.exit truncates the streams.
                    setImmediate(() => process.send({ handled: true }, () => process.disconnect()));
                    throw new MigrationBatchFailure(1, 1);
                } };
                return load.call(this, request, ...args);
            };
            require(${JSON.stringify(path.resolve(__dirname, '../src/bin/camunda-cli.ts'))});
        `;
        const child = spawn(process.execPath, ['-e', script], {
            env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let stdout = ''; let stderr = '';
        let pressure: { stdoutPending: number; stderrPending: number } | undefined;
        let reading = false;
        const readPipes = () => {
            if (reading) return;
            reading = true;
            child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
            child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        };
        child.on('message', (message: { pressure?: boolean; handled?: boolean; stdoutPending: number; stderrPending: number }) => {
            if (message.pressure) pressure = message;
            if (message.handled) readPipes();
        });
        child.on('exit', readPipes);
        let timeout: NodeJS.Timeout | undefined;
        try {
            const code = await new Promise<number | null>((resolve, reject) => {
                child.once('error', reject);
                child.once('close', (code) => resolve(code));
                timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child did not finish draining output.')); }, 10000);
            });
            expect(pressure?.stdoutPending).toBeGreaterThan(0);
            expect(pressure?.stderrPending).toBeGreaterThan(0);
            expect(code).toBe(1);
            expect(stdout.length).toBe(size + 1 + summary.length + 1);
            expect(stderr.length).toBe(size + 1);
            expect(stdout).toBe('S'.repeat(size) + '\n' + summary + '\n');
            expect(stderr).toBe('D'.repeat(size) + '\n');
            expect(stdout.split(summary)).toHaveLength(2);
        } finally {
            clearTimeout(timeout);
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await fs.rm(home, { recursive: true, force: true });
        }
    }, 15000);

    let originalExitCode: typeof process.exitCode;
    beforeEach(() => {
        jest.resetModules();
        originalExitCode = process.exitCode;
        process.exitCode = undefined;
    });
    afterEach(() => {
        process.exitCode = originalExitCode;
        jest.restoreAllMocks();
        jest.dontMock('../src/bootstrap/camundaCli');
    });

    async function runExecutable(run: () => Promise<void>) {
        jest.doMock('../src/bootstrap/camundaCli', () => ({ runDefaultCamundaCli: run }));
        await import('../src/bin/camunda-cli');
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    test.each(['partial failure', 'all failure', 'success'])('%s processes the batch before deciding exit status', async (scenario) => {
        const { MigrateProcessInstancesUseCase } = await import('../src/application/usecases/migrateProcessInstancesUseCase');
        const { ConsoleMigrationsPresenter } = await import('../src/adapter/out/consoleMigrationsPresenter');
        const events: string[] = [];
        const output = jest.spyOn(console, 'log').mockImplementation((line: string) => { events.push(line); });
        const diagnostic = jest.spyOn(console, 'error').mockImplementation((line: string) => { events.push(line); });
        const exit = jest.spyOn(process, 'exit').mockImplementation(() => { events.push('exit'); return undefined as never; });
        const migrate = jest.fn(async (key: string) => {
            events.push(`attempt ${key}`);
            if (scenario === 'all failure' || (scenario === 'partial failure' && key === '10')) throw new Error('HTTP 409 dummy-secret');
        });
        const usecase = new MigrateProcessInstancesUseCase({ getProfile: () => ({
            name: 'dummy', baseUrl: 'http://gateway.example/v2', operateUrl: 'http://operate.example/v1',
        }) }, { connect: async () => ({
            searchDefinitions: async (id, version) => [{ key: String(version), bpmnProcessId: id, version }],
            searchActiveInstances: async () => ['10', '11'].map((key) => ({ key, processDefinitionKey: '1', state: 'ACTIVE' as const })),
            migrate,
        }) }, new ConsoleMigrationsPresenter());
        await runExecutable(() => usecase.migrateProcessInstances({ profile: 'dummy', migrationPlan: [{
            processDefinition: 'dummy-process', sourceVersion: 1, targetVersion: 2, mappingInstructions: [],
        }] }));
        const failed = scenario === 'all failure' ? 2 : scenario === 'partial failure' ? 1 : 0;
        const summary = `Migrated ${2 - failed} process instance(s). ${failed} failed.`;
        expect(migrate.mock.calls.map(([key]) => key)).toEqual(['10', '11']);
        expect(output.mock.calls.filter(([line]) => line === summary)).toHaveLength(1);
        expect(diagnostic).toHaveBeenCalledTimes(failed);
        expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/dummy-secret|Migration batch completed/);
        if (failed) {
            expect(exit).not.toHaveBeenCalled();
            expect(process.exitCode).toBe(1);
            expect(events[events.length - 1]).toBe(summary);
            expect(events.indexOf('attempt 11')).toBeGreaterThan(events.findIndex((event) => event.startsWith('Migration failed for instance 10')));
        } else {
            expect(exit).not.toHaveBeenCalled();
            expect(process.exitCode).toBeUndefined();
            expect(events[events.length - 1]).toBe(summary);
        }
    });

    test.each([new Error('Preflight failed.'), 'Unknown thrown value', undefined])('prints ordinary rejection %j and exits 1', async (error) => {
        const diagnostic = jest.spyOn(console, 'error').mockImplementation(() => {});
        const output = jest.spyOn(console, 'log').mockImplementation(() => {});
        const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        await runExecutable(async () => { throw error; });
        expect(diagnostic).toHaveBeenCalledTimes(1);
        expect(diagnostic).toHaveBeenCalledWith(error instanceof Error ? error.message : String(error));
        expect(output).not.toHaveBeenCalled();
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(1);
    });
});
