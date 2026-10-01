import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import {
    createDefaultCamundaCli, DefaultCamundaCli, JsonProfileRepositoryAdapter,
    ProfileCache, runDefaultCamundaCli,
} from '../src';

const notice = 'Please add a profile with the add profile command.';
const profiles = [
    {
        name: ' remote ', baseUrl: ' base ', clientId: 'client', clientSecret: ' dummy-secret ',
        audience: 'audience', oAuthUrl: 'oauth', operateUrl: 'operate', zeebeUrl: 'zeebe',
        future: { nested: ['original'] },
    },
    { name: 'Remote', baseUrl: 'other' },
];

describe('default runtime profile initialization', () => {
    let home: string;
    let directory: string;
    let filePath: string;
    let output: jest.Mock;
    let program: DefaultCamundaCli;

    beforeEach(async () => {
        home = await mkdtemp(path.join(tmpdir(), 'camunda-startup-'));
        directory = path.join(home, '.lmoesle-camunda-cli');
        filePath = path.join(directory, 'profiles.json');
        output = jest.fn();
        program = createDefaultCamundaCli({ homeDirectory: home, writeLine: output });
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await rm(home, { recursive: true, force: true });
    });

    async function store(value: unknown): Promise<void> {
        await mkdir(directory);
        await writeFile(filePath, JSON.stringify(value));
    }

    test('loads complete profiles once before actions and keeps a defensive startup snapshot', async () => {
        await store({ profiles });
        const load = jest.spyOn(JsonProfileRepositoryAdapter.prototype, 'loadProfiles');
        const action = jest.fn(() => {
            expect(program.profiles.getProfiles()).toEqual(profiles);
        });
        program.command('inspect').action(action);
        expect(program).toBeInstanceOf(Command);
        expect(program.profiles.getProfiles()).toEqual([]);
        await Promise.all([program.initialize(), program.initialize()]);
        await program.parseAsync(['inspect'], { from: 'user' });
        expect(action).toHaveBeenCalledTimes(1);
        expect(output).not.toHaveBeenCalled();
        expect(program.profiles.getProfile(' remote ')).toEqual(profiles[0]);
        expect(program.profiles.getProfile('Remote')).toEqual(profiles[1]);
        expect(program.profiles.getProfile('REMOTE')).toBeUndefined();
        const copy = program.profiles.getProfiles() as typeof profiles;
        copy[0].future!.nested.push('mutated');
        copy.reverse();
        const single = program.profiles.getProfile('remote') as typeof profiles[0];
        single.future!.nested[0] = 'mutated';
        single.clientSecret = 'changed';
        await writeFile(filePath, '{"profiles":[]}');
        await program.initialize();
        expect(program.profiles.getProfiles()).toEqual(profiles);
        expect(load).toHaveBeenCalledTimes(1);
    });

    test('preAction initializes even without an explicit initialize call', async () => {
        await store({ profiles });
        program.command('inspect').action(() => {
            expect(program.profiles.getProfiles()).toEqual(profiles);
        });
        await program.parseAsync(['inspect'], { from: 'user' });
    });

    test.each(['directory', 'file'])('missing %s emits the exact notice once without creating storage', async (missing) => {
        if (missing === 'file') {
            await mkdir(directory);
        }
        await program.initialize();
        await program.parseAsync(['hello-world'], { from: 'user' });
        await program.initialize();
        expect(output.mock.calls).toEqual([[notice], ['Hello, World!']]);
        expect(program.profiles.getProfiles()).toEqual([]);
        expect(await readdir(missing === 'file' ? directory : home)).toEqual([]);
        expect(await new JsonProfileRepositoryAdapter(home).listProfiles()).toEqual([]);
    });

    test('valid empty storage does not emit a missing notice', async () => {
        await store({ profiles: [] });
        await program.initialize();
        expect(program.profiles.getProfiles()).toEqual([]);
        expect(output).not.toHaveBeenCalled();
    });

    test('independent runtimes never share cache state across homes', async () => {
        await store({ profiles });
        const otherHome = path.join(home, 'other');
        await mkdir(otherHome);
        const other = createDefaultCamundaCli({ homeDirectory: otherHome, writeLine: () => undefined });
        await Promise.all([program.initialize(), other.initialize()]);
        expect(program.profiles.getProfiles()).toEqual(profiles);
        expect(other.profiles.getProfiles()).toEqual([]);
    });

    test.each([
        '{"dummy-secret": BROKEN',
        JSON.stringify({ profiles: [profiles[0], { name: 'invalid' }] }),
        JSON.stringify({ profiles: [profiles[0], { name: 'remote', baseUrl: 'duplicate' }] }),
    ])('invalid storage fails safely before action with no partial cache', async (content) => {
        await mkdir(directory);
        await writeFile(filePath, content);
        const action = jest.fn();
        program.command('inspect').action(action);
        const load = jest.spyOn(JsonProfileRepositoryAdapter.prototype, 'loadProfiles');
        await expect(program.parseAsync(['inspect'], { from: 'user' })).rejects.toThrow('invalid JSON or an invalid profile schema');
        await expect(program.initialize()).rejects.not.toThrow('dummy-secret');
        expect(load).toHaveBeenCalledTimes(1);
        expect(action).not.toHaveBeenCalled();
        expect(output).not.toHaveBeenCalled();
        expect(program.profiles.getProfiles()).toEqual([]);
        expect(await readFile(filePath, 'utf8')).toBe(content);
    });

    test('unreadable storage sanitizes errors before action', async () => {
        await store({ profiles });
        jest.spyOn(fs, 'open').mockRejectedValue(Object.assign(new Error('dummy-secret'), { code: 'EACCES' }));
        await expect(program.parseAsync(['hello-world'], { from: 'user' })).rejects.toThrow(
            'Unable to access profile storage. Check permissions and available disk space.',
        );
        expect(output).not.toHaveBeenCalled();
        expect(program.profiles.getProfiles()).toEqual([]);
    });

    test.each(['directory', 'file'])('symlink %s fails before action without a notice', async (target) => {
        const outside = path.join(home, 'outside');
        if (target === 'directory') {
            await mkdir(outside);
            await symlink(outside, directory, 'dir');
        } else {
            await mkdir(directory);
            await writeFile(outside, '{"profiles":[]}');
            await symlink(outside, filePath);
        }
        await expect(program.parseAsync(['hello-world'], { from: 'user' })).rejects.toThrow('symbolic link');
        expect(output).not.toHaveBeenCalled();
        expect(program.profiles.getProfiles()).toEqual([]);
    });

    test('add persists without changing the startup snapshot; a new runtime loads it', async () => {
        await store({ profiles });
        await program.initialize();
        await program.parseAsync(['add', 'profile', '--name', ' local ', '--base-url', 'xxx'], { from: 'user' });
        const expected = [...profiles, { name: 'local', baseUrl: 'xxx' }];
        expect(JSON.parse(await readFile(filePath, 'utf8')).profiles).toEqual(expected);
        expect(program.profiles.getProfiles()).toEqual(profiles);
        await program.initialize();
        expect(program.profiles.getProfile('local')).toBeUndefined();
        const next = createDefaultCamundaCli({ homeDirectory: home, writeLine: output });
        await next.initialize();
        expect(next.profiles.getProfiles()).toEqual(expected);
        await expect(program.parseAsync(['add', 'profile', '--name', 'local', '--base-url', 'xxx'], { from: 'user' }))
            .rejects.toThrow('already exists');
        jest.spyOn(fs, 'rename').mockRejectedValue(new Error('dummy-secret'));
        await expect(program.parseAsync(['add', 'profile', '--name', 'failed', '--base-url', 'xxx'], { from: 'user' }))
            .rejects.toThrow('Unable to access profile storage');
        expect(program.profiles.getProfiles()).toEqual(profiles);
        expect(JSON.parse(await readFile(filePath, 'utf8')).profiles).toEqual(expected);
        expect(output).not.toHaveBeenCalled();
    });

    test('first add initializes missing storage once and leaves an empty snapshot until a new runtime', async () => {
        await program.parseAsync(['add', 'profile', '--name', 'local', '--base-url', 'xxx'], { from: 'user' });
        const expected = [{ name: 'local', baseUrl: 'xxx' }];
        expect(JSON.parse(await readFile(filePath, 'utf8')).profiles).toEqual(expected);
        await program.initialize();
        expect(program.profiles.getProfiles()).toEqual([]);
        expect(program.profiles.getProfile('local')).toBeUndefined();
        expect(output.mock.calls).toEqual([[notice]]);
        const next = createDefaultCamundaCli({ homeDirectory: home, writeLine: output });
        await next.initialize();
        expect(next.profiles.getProfiles()).toEqual(expected);
        expect(output.mock.calls).toEqual([[notice]]);
    });

    test.each([{ args: ['--help'] }, { args: ['--version'] }, { args: [] }])('runner initializes before parsing %j', async ({ args }) => {
        await store({ profiles });
        const load = jest.spyOn(JsonProfileRepositoryAdapter.prototype, 'loadProfiles');
        // Intercept parsing to avoid Commander's process.exit for help/version/no command.
        const parse = jest.spyOn(Command.prototype, 'parseAsync').mockImplementation(async function (this: Command) {
            expect(load).toHaveBeenCalledTimes(1);
            expect((this as DefaultCamundaCli).profiles.getProfiles()).toEqual(profiles);
            return this;
        });
        const argv = ['node', 'camunda-cli', ...args];
        await runDefaultCamundaCli(argv, { homeDirectory: home, writeLine: output });
        expect(parse).toHaveBeenCalledWith(argv);
    });

    test('runner rejects broken startup storage before help parsing', async () => {
        await store({ profiles: [null] });
        const parse = jest.spyOn(Command.prototype, 'parseAsync');
        await expect(runDefaultCamundaCli(['node', 'cli', '--help'], { homeDirectory: home, writeLine: output }))
            .rejects.toThrow('invalid profile schema');
        expect(parse).not.toHaveBeenCalled();
        expect(output).not.toHaveBeenCalled();
    });
});

test('cache clones inputs when replacing the startup snapshot', () => {
    const cache = new ProfileCache();
    const input = structuredClone(profiles);
    cache.replaceProfiles(input);
    input[0].future!.nested.push('mutated');
    expect(cache.getProfiles()).toEqual(profiles);
});
