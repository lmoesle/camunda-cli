import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
    AddProfileUseCase, createCamundaCli, createDefaultCamundaCli,
    JsonProfileRepositoryAdapter, Profile, ProfileRepositoryOutPort,
} from '../src';

const fullProfile: Profile = {
    name: 'remote', baseUrl: 'xxx', clientId: 'client', clientSecret: ' dummy secret ',
    audience: 'audience', oAuthUrl: 'oauth', operateUrl: 'operate', zeebeUrl: 'zeebe',
};

describe('add profile use case', () => {
    let repository: ProfileRepositoryOutPort;
    let useCase: AddProfileUseCase;

    beforeEach(() => {
        repository = { addProfile: jest.fn(), listProfiles: jest.fn() };
        useCase = new AddProfileUseCase(repository);
    });

    test.each([{ name: 'local', baseUrl: 'xxx' }, fullProfile])('stores a validated profile', async (profile) => {
        await useCase.addProfile(profile);
        expect(repository.addProfile).toHaveBeenCalledWith(profile);
    });

    test('trims names without changing secrets or other values', async () => {
        await useCase.addProfile({ ...fullProfile, name: ' remote ' });
        expect(repository.addProfile).toHaveBeenCalledWith(fullProfile);
    });

    test.each([
        { baseUrl: 'xxx' }, { name: 'local' }, { name: ' ', baseUrl: 'xxx' },
        { name: 'local', baseUrl: '\t' },
    ])('rejects missing/blank mandatory values without writing', async (profile) => {
        await expect(useCase.addProfile(profile as Profile)).rejects.toThrow('non-whitespace');
        expect(repository.addProfile).not.toHaveBeenCalled();
    });
});

describe('profile JSON storage and default CLI', () => {
    let home: string;
    let directory: string;
    let filePath: string;
    let repository: JsonProfileRepositoryAdapter;

    beforeEach(async () => {
        home = await mkdtemp(path.join(tmpdir(), 'camunda-profiles-'));
        directory = path.join(home, '.lmoesle-camunda-cli');
        filePath = path.join(directory, 'profiles.json');
        repository = new JsonProfileRepositoryAdapter(home);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await rm(home, { recursive: true, force: true });
    });

    test('lists missing storage without creating it', async () => {
        expect(await repository.listProfiles()).toEqual([]);
        expect(await readdir(home)).toEqual([]);
    });

    test('stores minimal JSON at the default home path, not cwd', async () => {
        jest.spyOn(os, 'homedir').mockReturnValue(home);
        await createDefaultCamundaCli().parseAsync(['add', 'profile', '--name', 'local', '--base-url', 'xxx'], { from: 'user' });
        expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ profiles: [{ name: 'local', baseUrl: 'xxx' }] });
    });

    test('maps all CLI flags including oAuthUrl and prints no credentials', async () => {
        const writeLine = jest.fn();
        await createDefaultCamundaCli({ homeDirectory: home, writeLine }).parseAsync([
            'add', 'profile', '--name', 'remote', '--base-url', 'xxx',
            '--client-id', 'client', '--client-secret', ' dummy secret ', '--audience', 'audience',
            '--oauth-url', 'oauth', '--operate-url', 'operate', '--zeebe-url', 'zeebe',
        ], { from: 'user' });
        expect(await repository.listProfiles()).toEqual([fullProfile]);
        expect(writeLine.mock.calls).toEqual([['Please add a profile with the add profile command.']]);
    });

    test.each([
        ['--base-url', 'xxx'], ['--name', 'local'], ['--name', ' ', '--base-url', 'xxx'],
        ['--name', 'local', '--base-url', '\t'],
    ])('rejects invalid CLI input before creating storage: %j', async (...flags) => {
        const program = createDefaultCamundaCli({ homeDirectory: home }).exitOverride();
        program.configureOutput({ writeErr: () => undefined });
        const profileCommand = program.commands.find((command) => command.name() === 'add')!.commands[0];
        profileCommand.exitOverride().configureOutput({ writeErr: () => undefined });
        await expect(program.parseAsync(['add', 'profile', ...flags], { from: 'user' })).rejects.toThrow();
        expect(await readdir(home)).toEqual([]);
    });

    test('construction, help generation, and old commands do not create storage', async () => {
        const program = createDefaultCamundaCli({ homeDirectory: home, writeLine: () => undefined });
        expect(program.helpInformation()).toContain('add');
        await program.parseAsync(['hello-world'], { from: 'user' });
        expect(await readdir(home)).toEqual([]);
    });

    test('keeps existing entries, order, and unknown keys; duplicate comparison is case-sensitive', async () => {
        await mkdir(directory);
        const existing = { ...fullProfile, futureField: 'preserved' };
        await writeFile(filePath, JSON.stringify({ profiles: [existing], futureSetting: true }));
        await repository.addProfile({ name: 'Remote', baseUrl: 'another' });
        expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
            profiles: [existing, { name: 'Remote', baseUrl: 'another' }], futureSetting: true,
        });
        const before = await readFile(filePath, 'utf8');
        await expect(repository.addProfile({ name: ' remote ', baseUrl: 'other' })).rejects.toThrow('already exists');
        expect(await readFile(filePath, 'utf8')).toBe(before);
        expect(await readdir(directory)).toEqual(['profiles.json']);
    });

    test.each([
        '{"clientSecret":"dummy-secret", BROKEN', 'null', '{}', '{"profiles":{}}',
        '{"profiles":[{"name":"local","baseUrl":" "}]}',
        '{"profiles":[{"name":"local","baseUrl":"xxx","clientSecret":123}]}',
        '{"profiles":[{"name":"local","baseUrl":"xxx"},{"name":" local ","baseUrl":"xxx"}]}',
    ])('rejects corrupt storage without overwriting or exposing content', async (content) => {
        await mkdir(directory);
        await writeFile(filePath, content);
        await expect(repository.addProfile(fullProfile)).rejects.toThrow('invalid JSON or an invalid profile schema');
        await expect(repository.listProfiles()).rejects.not.toThrow('dummy-secret');
        expect(await readFile(filePath, 'utf8')).toBe(content);
        expect(await readdir(directory)).toEqual(['profiles.json']);
    });

    test('restricts managed directory/file permissions without modifying home', async () => {
        await mkdir(directory, { mode: 0o755 });
        const homeMode = (await stat(home)).mode;
        await repository.addProfile(fullProfile);
        await repository.addProfile({ name: 'local', baseUrl: 'xxx' });
        if (process.platform !== 'win32') {
            expect((await stat(directory)).mode & 0o777).toBe(0o700);
            expect((await stat(filePath)).mode & 0o777).toBe(0o600);
            expect((await stat(home)).mode).toBe(homeMode);
        }
    });

    test.each(['directory', 'file'])('rejects a symbolic-link configuration %s', async (target) => {
        const outside = path.join(home, 'outside');
        if (target === 'directory') {
            await mkdir(outside);
            await symlink(outside, directory, 'dir');
        } else {
            await mkdir(directory);
            await writeFile(outside, '{"profiles":[]}');
            await symlink(outside, filePath);
        }
        await expect(repository.addProfile(fullProfile)).rejects.toThrow('symbolic link');
        await expect(repository.listProfiles()).rejects.toThrow('symbolic link');
        if (target === 'directory') {
            expect(await readdir(outside)).toEqual([]);
        } else {
            expect(await readFile(outside, 'utf8')).toBe('{"profiles":[]}');
        }
    });

    test('cleans temporary files and lock after failed rename, preserving original JSON', async () => {
        await repository.addProfile(fullProfile);
        const before = await readFile(filePath, 'utf8');
        jest.spyOn(fs, 'rename').mockImplementation(async (temporaryPath) => {
            if (process.platform !== 'win32') {
                expect((await stat(temporaryPath)).mode & 0o777).toBe(0o600);
            }
            throw new Error('dummy-secret');
        });
        await expect(repository.addProfile({ name: 'local', baseUrl: 'xxx' })).rejects.toThrow('Unable to access profile storage');
        expect(await readFile(filePath, 'utf8')).toBe(before);
        expect(await readdir(directory)).toEqual(['profiles.json']);
    });

    test('sanitizes unreadable storage errors and leaves original intact', async () => {
        await repository.addProfile(fullProfile);
        const before = await readFile(filePath, 'utf8');
        const originalOpen = fs.open;
        jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
            if (args[0] === filePath) {
                throw new Error('dummy-secret');
            }
            return originalOpen(...args);
        });
        await expect(repository.addProfile({ name: 'local', baseUrl: 'xxx' })).rejects.toThrow('Unable to access profile storage');
        expect(await readFile(filePath, 'utf8')).toBe(before);
        expect(await readdir(directory)).toEqual(['profiles.json']);
    });

    test('concurrent adapters never silently lose a successful addition', async () => {
        const results = await Promise.allSettled([
            repository.addProfile(fullProfile),
            new JsonProfileRepositoryAdapter(home).addProfile({ name: 'local', baseUrl: 'xxx' }),
        ]);
        const profiles = await repository.listProfiles();
        expect(profiles).toHaveLength(results.filter((result) => result.status === 'fulfilled').length);
        for (const result of results) {
            if (result.status === 'rejected') {
                expect(result.reason.message).toContain('locked');
            }
        }
        expect(await readdir(directory)).toEqual(['profiles.json']);
    });

    test('an existing lock fails clearly and remains owned by its creator', async () => {
        await mkdir(directory);
        await writeFile(path.join(directory, 'profiles.lock'), '');
        await expect(repository.addProfile(fullProfile)).rejects.toThrow('locked');
        expect(await readdir(directory)).toEqual(['profiles.lock']);
    });
});

test('legacy CLI dependency consumers get a clear error only when invoking add profile', async () => {
    const program = createCamundaCli({
        downloadFilesInPort: { downloadFiles: jest.fn(), downloadFile: jest.fn() },
        sayHelloWorldInPort: { sayHelloWorld: jest.fn() },
    });
    await expect(program.parseAsync(['add', 'profile', '--name', 'local', '--base-url', 'xxx'], { from: 'user' }))
        .rejects.toThrow('AddProfileInPort');
});
