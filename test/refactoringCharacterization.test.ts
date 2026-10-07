import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonProfileRepositoryAdapter, Profile } from '../src';
import { createProfile, optionalProfileFields } from '../src/domain/profile';

describe('new profile validation', () => {
    test.each([null, 12, '', ' '])('rejects invalid required values %j in field order', (value) => {
        expect(() => createProfile({ name: value, baseUrl: value } as unknown as Profile))
            .toThrow('Profile name must be a non-whitespace string.');
        expect(() => createProfile({ name: 'valid', baseUrl: value } as unknown as Profile))
            .toThrow('Profile baseUrl must be a non-whitespace string.');
    });

    test.each(optionalProfileFields)('validates optional %s without altering string values', (field) => {
        const input = { name: ' name ', baseUrl: ' base ', [field]: ' dummy value ' };
        expect(createProfile(input)).toEqual({ ...input, name: 'name' });
        expect(createProfile({ ...input, [field]: undefined })).toEqual({ name: 'name', baseUrl: ' base ' });
        expect(() => createProfile({ ...input, [field]: null } as unknown as Profile))
            .toThrow('Optional profile fields must be strings.');
    });
});

describe('persisted profile validation and safe reading', () => {
    let home: string;
    let filePath: string;
    let repository: JsonProfileRepositoryAdapter;

    beforeEach(async () => {
        home = await mkdtemp(path.join(tmpdir(), 'camunda-characterization-'));
        const directory = path.join(home, '.lmoesle-camunda-cli');
        await mkdir(directory);
        filePath = path.join(directory, 'profiles.json');
        repository = new JsonProfileRepositoryAdapter(home);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await rm(home, { recursive: true, force: true });
    });

    test.each([
        null, [], {}, { profiles: null }, { profiles: [null] }, { profiles: [[]] },
        { profiles: [{ name: 1, baseUrl: 'base' }] }, { profiles: [{ name: ' ', baseUrl: 'base' }] },
        { profiles: [{ name: 'name', baseUrl: null }] },
        ...optionalProfileFields.map((field) => ({ profiles: [{ name: 'name', baseUrl: 'base', [field]: null }] })),
        { profiles: [{ name: 'name', baseUrl: 'a' }, { name: ' name ', baseUrl: 'b' }] },
    ])('rejects malformed persisted document %j', async (document) => {
        await writeFile(filePath, JSON.stringify(document));
        await expect(repository.loadProfiles()).rejects.toThrow('Profile storage contains invalid JSON or an invalid profile schema.');
    });

    test.each(['ENOENT', 'EACCES'])('handles %s from path inspection', async (code) => {
        jest.spyOn(fs, 'lstat').mockRejectedValue(Object.assign(new Error('dummy-secret'), { code }));
        if (code === 'ENOENT') {
            await expect(repository.loadProfiles()).resolves.toBeUndefined();
        } else {
            const result = repository.loadProfiles();
            await expect(result).rejects.toThrow('Unable to access profile storage.');
            await expect(result).rejects.not.toHaveProperty('cause');
        }
    });

    test.each(['success', 'read failure', 'not regular'])('closes the no-follow file handle on %s', async (scenario) => {
        await writeFile(filePath, '{}');
        const profiles = [{ name: ' name ', baseUrl: ' base ', clientSecret: ' dummy ', future: true }];
        const close = jest.fn().mockResolvedValue(undefined);
        const readFile = jest.fn().mockResolvedValue(JSON.stringify({ profiles, future: true }));
        if (scenario === 'read failure') {
            readFile.mockRejectedValue(new Error('dummy-secret'));
        }
        const handle = { stat: jest.fn().mockResolvedValue({ isFile: () => scenario !== 'not regular' }), readFile, close };
        const open = jest.spyOn(fs, 'open').mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof fs.open>>);
        if (scenario === 'success') {
            await expect(repository.loadProfiles()).resolves.toEqual(profiles);
        } else {
            await expect(repository.loadProfiles()).rejects.toThrow();
        }
        expect(open).toHaveBeenCalledWith(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        expect(close).toHaveBeenCalledTimes(1);
        if (scenario === 'not regular') {
            expect(readFile).not.toHaveBeenCalled();
        }
    });
});
