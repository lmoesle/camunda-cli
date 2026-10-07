import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { CamundaCliDependencies, createCamundaCli, createDefaultCamundaCli } from '../src';

function overrideExits(program: Command): Command {
    program.exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    program.commands.forEach(overrideExits);
    return program;
}

describe('supported CLI commands', () => {
    let home: string;

    beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'camunda-commands-')); });
    afterEach(async () => { await rm(home, { recursive: true, force: true }); });

    test.each(['injected', 'default'])('%s runtime exposes only supported commands without startup I/O', async (runtime) => {
        const writeLine = jest.fn();
        const program = overrideExits(runtime === 'default'
            ? createDefaultCamundaCli({ homeDirectory: home, writeLine }) : createCamundaCli({}));
        expect(program.commands.map((command) => command.name())).toEqual(['migrate', 'deploy', 'incident', 'incidents', 'add']);
        expect(program.commands.find((command) => command.name() === 'incident')!.commands.map((command) => command.name()))
            .toEqual(['retry']);
        expect(program.commands.find((command) => command.name() === 'add')!.commands.map((command) => command.name()))
            .toEqual(['profile']);
        expect(program.helpInformation()).not.toMatch(/download|hello-world/);
        await expect(program.parseAsync(['--help'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.helpDisplayed', exitCode: 0 });
        expect(writeLine).not.toHaveBeenCalled();
        expect(await readdir(home)).toEqual([]);
    });

    test.each([
        ['download'], ['download', 'files'], ['download', 'file', 'example-id'],
        ['hello-world'], ['hello-world', 'Camunda'],
    ])('rejects removed command argv %j in both runtimes', async (...args) => {
        for (const program of [createCamundaCli({}), createDefaultCamundaCli({ homeDirectory: home, writeLine: jest.fn() })]) {
            const writeErr = jest.fn();
            overrideExits(program).configureOutput({ writeErr });
            await expect(program.parseAsync(args, { from: 'user' })).rejects.toMatchObject({
                code: 'commander.unknownCommand', exitCode: 1,
            });
            expect(writeErr).toHaveBeenCalledWith(expect.stringContaining(`unknown command '${args[0]}'`));
        }
        expect(await readdir(home)).toEqual([]);
    });
});

const scenarios: {
    name: string;
    args: string[];
    dependencies: (action: jest.Mock) => CamundaCliDependencies;
    expected: object;
    missingPort: string;
}[] = [
    {
        name: 'add profile', args: ['add', 'profile', '--name', 'local', '--base-url', 'xxx'],
        dependencies: (addProfile) => ({ addProfileInPort: { addProfile } }),
        expected: { name: 'local', baseUrl: 'xxx', oAuthUrl: undefined }, missingPort: 'AddProfileInPort',
    },
    {
        name: 'incidents', args: ['incidents', '--profile', 'local', '--json'],
        dependencies: (listIncidents) => ({ listIncidentsInPort: { listIncidents } }),
        expected: { profile: 'local', json: true }, missingPort: 'ListIncidentsInPort',
    },
    {
        name: 'deploy', args: ['deploy', 'models', '--profile', 'local', '-r'],
        dependencies: (deployFiles) => ({ deployFilesInPort: { deployFiles } }),
        expected: { path: 'models', profile: 'local', recursive: true }, missingPort: 'DeployFilesInPort',
    },
    {
        name: 'migrate', args: ['migrate', '--profile', 'local', '--migrationPlan', '[]'],
        dependencies: (migrateProcessInstances) => ({ migrateProcessInstancesInPort: { migrateProcessInstances } }),
        expected: { profile: 'local', migrationPlan: '[]' }, missingPort: 'MigrateProcessInstancesInPort',
    },
    {
        name: 'incident retry', args: ['incident', 'retry', '--incident', '1', '--job', '2', '--profile', 'local'],
        dependencies: (retryIncident) => ({ retryIncidentInPort: { retryIncident } }),
        expected: { incident: '1', job: '2', profile: 'local' }, missingPort: 'RetryIncidentInPort',
    },
];

test.each(scenarios)('$name dispatches with only its own port and checks missing dependencies at invocation', async (scenario) => {
    const action = jest.fn().mockResolvedValue(undefined);
    await createCamundaCli(scenario.dependencies(action)).parseAsync(scenario.args, { from: 'user' });
    expect(action.mock.calls).toEqual([[scenario.expected]]);
    const program = createCamundaCli({});
    expect(program.helpInformation()).toContain(scenario.args[0]);
    await expect(program.parseAsync(scenario.args, { from: 'user' })).rejects.toThrow(scenario.missingPort);
});
