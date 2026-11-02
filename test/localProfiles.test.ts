import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDefaultCamundaCli, JsonProfileRepositoryAdapter, runDefaultCamundaCli } from '../src';
import { AxiosIncidentAdapter } from '../src/adapter/out/axiosIncidentAdapter';

const homeProfile = { name: 'selected', baseUrl: 'https://home.invalid', future: { keep: true } };
const localProfile = {
    name: 'selected', baseUrl: 'https://project.invalid', operateUrl: 'https://operate.project.invalid',
    clientId: 'dummy-client', clientSecret: 'dummy-secret', oAuthUrl: 'https://oauth.invalid',
};
const notice = 'Please add a profile with the add profile command.';
const storagePath = (root: string): string => path.join(root, '.lmoesle-camunda-cli', 'profiles.json');

describe('current-directory profile overrides', () => {
    let root: string;
    let home: string;
    let project: string;
    let repository: JsonProfileRepositoryAdapter;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(tmpdir(), 'camunda-local-profiles-'));
        home = path.join(root, 'home');
        project = path.join(root, 'project');
        await Promise.all([fs.mkdir(home), fs.mkdir(project)]);
        repository = new JsonProfileRepositoryAdapter(home, project);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await fs.rm(root, { recursive: true, force: true });
    });

    async function store(directory: string, document: unknown): Promise<void> {
        await fs.mkdir(path.dirname(storagePath(directory)), { recursive: true });
        await fs.writeFile(storagePath(directory), JSON.stringify(document));
    }

    test('local replaces the entire home document, including an empty profile list', async () => {
        await store(home, { profiles: [homeProfile, { name: 'home-only', baseUrl: 'https://home.invalid' }] });
        await store(project, { profiles: [localProfile] });
        expect(await repository.listProfiles()).toEqual([localProfile]);
        await store(project, { profiles: [] });
        const writeLine = jest.fn();
        const runtime = createDefaultCamundaCli({ homeDirectory: home, workingDirectory: project, writeLine });
        await runtime.initialize();
        expect(runtime.profiles.getProfiles()).toEqual([]);
        expect(writeLine).not.toHaveBeenCalled();
    });

    test.each(['invalid', 'unreadable', 'unsafe'])('valid local storage ignores %s home storage', async (scenario) => {
        await store(project, { profiles: [localProfile] });
        await store(home, { profiles: [homeProfile] });
        if (scenario === 'invalid') await fs.writeFile(storagePath(home), 'dummy-secret invalid JSON');
        if (scenario === 'unsafe') {
            await fs.rm(storagePath(home));
            await fs.mkdir(storagePath(home));
        }
        const original = fs.lstat;
        const probe = jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
            if (String(args[0]).startsWith(home)) throw new Error('dummy-secret home must not be accessed');
            return original(...args);
        });
        expect(await repository.listProfiles()).toEqual([localProfile]);
        expect(probe.mock.calls.every(([file]) => !String(file).startsWith(home))).toBe(true);
    });

    test.each(['directory', 'file'])('missing local %s falls back to home', async (missing) => {
        await store(home, { profiles: [homeProfile] });
        if (missing === 'file') await fs.mkdir(path.dirname(storagePath(project)));
        expect(await repository.listProfiles()).toEqual([homeProfile]);
    });

    test('both absent emits the notice without creating storage or searching ancestors', async () => {
        await store(root, { profiles: [localProfile] });
        const writeLine = jest.fn();
        const runtime = createDefaultCamundaCli({ homeDirectory: home, workingDirectory: project, writeLine });
        await runtime.initialize();
        expect(writeLine.mock.calls).toEqual([[notice]]);
        expect(runtime.profiles.getProfiles()).toEqual([]);
        expect(await fs.readdir(home)).toEqual([]);
        expect(await fs.readdir(project)).toEqual([]);
        await store(home, { profiles: [homeProfile] });
        expect(await repository.listProfiles()).toEqual([homeProfile]);
    });

    test('default bootstrap captures invocation cwd and command consumers use the local startup snapshot', async () => {
        await store(home, { profiles: [homeProfile, { name: 'home-only', baseUrl: 'https://home.invalid' }] });
        await store(project, { profiles: [localProfile] });
        const cwd = jest.spyOn(process, 'cwd').mockReturnValue(project);
        const search = jest.spyOn(AxiosIncidentAdapter.prototype, 'searchActiveIncidents').mockResolvedValue([]);
        const runtime = createDefaultCamundaCli({ homeDirectory: home, writeLine: jest.fn(), writeDiagnostic: jest.fn() });
        cwd.mockReturnValue(home);
        await runtime.initialize();
        await store(project, { profiles: [] });
        await runtime.initialize();
        await runtime.parseAsync(['incidents', '--profile', 'selected', '--json'], { from: 'user' });
        expect(search).toHaveBeenCalledWith(expect.objectContaining({ operateUrl: localProfile.operateUrl, clientSecret: 'dummy-secret' }));
        expect(runtime.profiles.getProfiles()).toEqual([localProfile]);
        await expect(runtime.parseAsync(['incidents', '--profile', 'home-only'], { from: 'user' })).rejects.toThrow('does not exist');
        expect(search).toHaveBeenCalledTimes(1);
    });

    test.each(['json', 'schema', 'unreadable', 'directory symlink', 'file symlink', 'nonregular directory', 'nonregular file'])(
        'unsafe local %s fails safely rather than consulting home, including before add/help', async (scenario) => {
            await store(home, { profiles: [homeProfile] });
            await store(project, { profiles: [localProfile] });
            let message = 'invalid JSON or an invalid profile schema';
            if (scenario === 'json') await fs.writeFile(storagePath(project), '{"dummy-secret": BROKEN');
            if (scenario === 'schema') await store(project, { profiles: [{ name: 'dummy-secret' }] });
            if (scenario === 'unreadable') {
                message = 'Unable to access profile storage';
                const original = fs.open;
                jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
                    if (args[0] === storagePath(project)) throw Object.assign(new Error(`${project} dummy-secret`), { code: 'EACCES' });
                    return original(...args);
                });
            }
            if (scenario === 'directory symlink' || scenario === 'nonregular directory') {
                message = 'must be a real directory';
                await fs.rm(path.dirname(storagePath(project)), { recursive: true });
                if (scenario === 'directory symlink') await fs.symlink(path.dirname(storagePath(home)), path.dirname(storagePath(project)), 'dir');
                else await fs.writeFile(path.dirname(storagePath(project)), 'dummy-secret');
            }
            if (scenario === 'file symlink' || scenario === 'nonregular file') {
                message = 'must be a regular file';
                await fs.rm(storagePath(project));
                if (scenario === 'file symlink') await fs.symlink(storagePath(home), storagePath(project));
                else await fs.mkdir(storagePath(project));
            }
            const error = repository.loadProfiles();
            await expect(error).rejects.toThrow(message);
            await expect(error).rejects.not.toThrow('dummy-secret');
            await expect(error).rejects.not.toThrow(project);
            await expect(error).rejects.not.toHaveProperty('cause');
            const options = { homeDirectory: home, workingDirectory: project, writeLine: jest.fn() };
            await expect(runDefaultCamundaCli(['node', 'cli', '--help'], options)).rejects.toThrow(message);
            await expect(createDefaultCamundaCli(options).parseAsync(['add', 'profile', '--name', 'new', '--base-url', 'xxx'], { from: 'user' }))
                .rejects.toThrow(message);
            expect(JSON.parse(await fs.readFile(storagePath(home), 'utf8'))).toEqual({ profiles: [homeProfile] });
            expect(options.writeLine).not.toHaveBeenCalled();
        },
    );

    test('add reads, checks duplicates, and appends only at home while preserving local bytes and permissions', async () => {
        const existing = { ...homeProfile, name: 'home-only' };
        await store(home, { profiles: [existing], futureSetting: true });
        await store(project, { profiles: [localProfile], localSetting: true });
        await fs.chmod(storagePath(project), 0o640);
        await fs.writeFile(path.join(path.dirname(storagePath(project)), 'keep'), 'untouched');
        const before = await fs.readFile(storagePath(project));
        const directoryMode = (await fs.stat(path.dirname(storagePath(project)))).mode;
        const fileMode = (await fs.stat(storagePath(project))).mode;
        const runtime = createDefaultCamundaCli({ homeDirectory: home, workingDirectory: project, writeLine: jest.fn() });
        await runtime.parseAsync(['add', 'profile', '--name', 'selected', '--base-url', 'https://new-home.invalid'], { from: 'user' });
        const expected = { profiles: [existing, { name: 'selected', baseUrl: 'https://new-home.invalid' }], futureSetting: true };
        expect(JSON.parse(await fs.readFile(storagePath(home), 'utf8'))).toEqual(expected);
        await expect(runtime.parseAsync(['add', 'profile', '--name', 'home-only', '--base-url', 'xxx'], { from: 'user' })).rejects.toThrow('already exists');
        expect(await fs.readFile(storagePath(project))).toEqual(before);
        expect((await fs.stat(storagePath(project))).mode).toBe(fileMode);
        expect((await fs.stat(path.dirname(storagePath(project)))).mode).toBe(directoryMode);
        expect((await fs.readdir(path.dirname(storagePath(project)))).sort()).toEqual(['keep', 'profiles.json']);
        expect(await fs.readFile(path.join(path.dirname(storagePath(project)), 'keep'), 'utf8')).toBe('untouched');
        expect(runtime.profiles.getProfiles()).toEqual([localProfile]);
    });

    test('add creates missing home storage with local present and still rejects malformed home storage', async () => {
        await store(project, { profiles: [localProfile] });
        const runtime = createDefaultCamundaCli({ homeDirectory: home, workingDirectory: project, writeLine: jest.fn() });
        await runtime.parseAsync(['add', 'profile', '--name', 'selected', '--base-url', 'xxx'], { from: 'user' });
        expect(JSON.parse(await fs.readFile(storagePath(home), 'utf8'))).toEqual({ profiles: [{ name: 'selected', baseUrl: 'xxx' }] });
        await fs.writeFile(storagePath(home), 'invalid dummy-secret');
        await expect(repository.addProfile({ name: 'other', baseUrl: 'xxx' })).rejects.toThrow('invalid profile schema');
        expect(await fs.readFile(storagePath(home), 'utf8')).toBe('invalid dummy-secret');
        expect(await repository.listProfiles()).toEqual([localProfile]);
    });

    test('cwd equal to home reads and appends the same storage safely', async () => {
        await store(home, { profiles: [homeProfile] });
        const same = new JsonProfileRepositoryAdapter(home, home);
        expect(await same.listProfiles()).toEqual([homeProfile]);
        await same.addProfile({ name: 'other', baseUrl: 'xxx' });
        expect(await same.listProfiles()).toEqual([homeProfile, { name: 'other', baseUrl: 'xxx' }]);
    });
});
