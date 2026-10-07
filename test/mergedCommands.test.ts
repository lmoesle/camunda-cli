import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCamundaCli, createDefaultCamundaCli, runDefaultCamundaCli } from '../src';

describe('migration and incident retry coexist', () => {
    test('dispatches both commands to their own optional ports', async () => {
        const migrateProcessInstances = jest.fn().mockResolvedValue(undefined);
        const retryIncident = jest.fn().mockResolvedValue(undefined);
        const program = createCamundaCli({
            migrateProcessInstancesInPort: { migrateProcessInstances },
            retryIncidentInPort: { retryIncident },
        });
        await program.parseAsync(['migrate', '--profile', 'selected', '--migrationPlan', '[]'], { from: 'user' });
        await program.parseAsync(['incident', 'retry', '--profile', 'selected', '--incident', '9007199254740993',
            '--job', '9223372036854775807'], { from: 'user' });
        expect(migrateProcessInstances.mock.calls).toEqual([[{ profile: 'selected', migrationPlan: '[]' }]]);
        expect(retryIncident.mock.calls).toEqual([[{ profile: 'selected', incident: '9007199254740993', job: '9223372036854775807' }]]);
    });

    test.each(['runner', 'direct'])('routes notices for both runtime commands to diagnostics: %s', async (mode) => {
        const home = await fs.mkdtemp(path.join(tmpdir(), 'camunda-merged-commands-'));
        try {
            for (const args of [
                ['migrate', '--profile', 'unknown', '--migrationPlan', JSON.stringify([
                    { processDefinition: 'example', sourceVersion: 1, targetVersion: 2, mappingInstructions: [] },
                ])],
                ['incident', 'retry', '--profile', 'unknown', '--incident', '1', '--job', '2'],
            ]) {
                const writeLine = jest.fn();
                const writeDiagnostic = jest.fn();
                const options = { homeDirectory: home, writeLine, writeDiagnostic };
                await expect(mode === 'runner' ? runDefaultCamundaCli(['node', 'cli', ...args], options) :
                    createDefaultCamundaCli(options).parseAsync(args, { from: 'user' })).rejects.toThrow('does not exist');
                expect(writeLine).not.toHaveBeenCalled();
                expect(writeDiagnostic.mock.calls).toEqual([['Please add a profile with the add profile command.']]);
            }
        } finally {
            await fs.rm(home, { recursive: true, force: true });
        }
    });
});
