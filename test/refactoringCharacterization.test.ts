import { AxiosInstance } from 'axios';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AxiosModelerFileAdapter, createDownloadFileName, DownloadFilesUseCase, JsonProfileRepositoryAdapter, Profile } from '../src';
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
            await expect(repository.loadProfiles()).rejects.toThrow('Unable to access profile storage.');
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

describe('download filename edge cases', () => {
    test.each([
        ['', '', 'unknown', 'modeler-file'],
        ['id', '... ', 'unknown', 'id'],
        ['...', '', 'unknown', 'modeler-file'],
        ['id', 'Process.BpMn', 'BPMN', 'Process.bpmn'],
        ['id', 'CON', 'BPMN', '_CON.bpmn'],
        ['id', 'LPT1.extra', 'unknown', '_LPT1.extra'],
    ])('names %s / %s / %s', (id, name, type, expected) => {
        expect(createDownloadFileName({ id, name, type })).toBe(expected);
    });

    test('truncates Unicode at character boundaries with the suffix intact', () => {
        expect(createDownloadFileName({ id: 'id', name: '😀'.repeat(100), type: 'BPMN' }, true))
            .toBe(`${'😀'.repeat(61)}-id.bpmn`);
    });

    test('reserves the underscore byte for Windows device names', () => {
        expect(createDownloadFileName({ id: 'id', name: `CON.${'a'.repeat(300)}`, type: 'unknown' }))
            .toBe(`_CON.${'a'.repeat(250)}`);
    });

    test('rejects an oversized fixed suffix', () => {
        const id = 'x'.repeat(249);
        expect(() => createDownloadFileName({ id, name: 'name', type: 'BPMN' }, true))
            .toThrow(`Modeler file ${id} has an identifier or extension that is too long.`);
    });
});

describe('Modeler URL validation', () => {
    test.each(['garbage', 'ftp://example.test', 'https://user@example.test', 'https://example.test?', 'https://example.test#',
        'https://example.test?query', 'https://example.test#fragment'])('rejects %s before bulk or single I/O', async (modelerApiUrl) => {
        const modeler = { findAllFiles: jest.fn(), getFile: jest.fn(), getVersion: jest.fn() };
        const writer = { writeFile: jest.fn() };
        const useCase = new DownloadFilesUseCase(modeler, writer);
        const command = { bearerToken: 'dummy', destinationDirectory: '/unused', modelerApiUrl };
        await expect(useCase.downloadFiles(command)).rejects.toThrow(`Invalid Modeler API URL: ${modelerApiUrl}`);
        await expect(useCase.downloadFile({ ...command, fileId: 'id' })).rejects.toThrow(`Invalid Modeler API URL: ${modelerApiUrl}`);
        expect(modeler.findAllFiles).not.toHaveBeenCalled();
        expect(modeler.getFile).not.toHaveBeenCalled();
        expect(writer.writeFile).not.toHaveBeenCalled();
    });

    test.each([
        [' HTTPS://EXAMPLE.TEST:443/api/v1/ ', 'https://example.test/api/v1'],
        ['http://example.test/api//', 'http://example.test/api/'],
        [undefined, undefined],
    ])('normalizes %s', async (modelerApiUrl, expected) => {
        const findAllFiles = jest.fn().mockResolvedValue([]);
        const useCase = new DownloadFilesUseCase({ findAllFiles, getFile: jest.fn(), getVersion: jest.fn() }, { writeFile: jest.fn() });
        await useCase.downloadFiles({ bearerToken: 'dummy', destinationDirectory: '/unused', modelerApiUrl });
        expect(findAllFiles).toHaveBeenCalledWith('dummy', expected);
    });
});

describe('Axios error translation and pagination', () => {
    test.each([
        [401, { detail: 'ignored' }, 'The bearer token is invalid or expired.'],
        [500, { detail: '', message: 'ignored' }, 'Failed to download Modeler file id: HTTP 500: '],
        [400, { detail: 1, message: 'message', title: 'ignored' }, 'Failed to download Modeler file id: HTTP 400: message'],
        [400, { detail: null, message: false, title: 'title' }, 'Failed to download Modeler file id: HTTP 400: title'],
        [undefined, undefined, 'Failed to download Modeler file id: network'],
        [0, 'payload', 'Failed to download Modeler file id: network'],
        [500, null, 'Failed to download Modeler file id: HTTP 500: network'],
        [500, {}, 'Failed to download Modeler file id: HTTP 500: network'],
    ])('translates status %s with payload %j', async (status, data, expected) => {
        const request = jest.fn().mockRejectedValue({ isAxiosError: true, message: 'network', response: { status, data } });
        const adapter = new AxiosModelerFileAdapter(undefined, { request } as unknown as AxiosInstance);
        await expect(adapter.getFile('dummy', 'id')).rejects.toThrow(expected);
    });

    test('rethrows non-Axios values unchanged', async () => {
        const error = { reason: 'unexpected' };
        const request = jest.fn().mockRejectedValue(error);
        const adapter = new AxiosModelerFileAdapter(undefined, { request } as unknown as AxiosInstance);
        await expect(adapter.getFile('dummy', 'id')).rejects.toBe(error);
    });

    test('uses the network error message when there is no HTTP response', async () => {
        const request = jest.fn().mockRejectedValue({ isAxiosError: true, message: 'connection refused' });
        const adapter = new AxiosModelerFileAdapter(undefined, { request } as unknown as AxiosInstance);
        await expect(adapter.getFile('dummy', 'id')).rejects.toThrow('Failed to download Modeler file id: connection refused');
    });

    test.each([0, 1, 50])('stops on a terminal page of length %s', async (length) => {
        const items = Array.from({ length }, (_, index) => ({ id: `${index}`, name: 'name', type: 'bpmn' }));
        const total = length === 50 ? 50 : 100;
        const request = jest.fn().mockResolvedValue({ data: { items, total } });
        const adapter = new AxiosModelerFileAdapter(undefined, { request } as unknown as AxiosInstance);
        await expect(adapter.findAllFiles('dummy')).resolves.toEqual(items);
        expect(request).toHaveBeenCalledTimes(1);
    });

    test('counts raw received items, replacing duplicates without moving their first insertion', async () => {
        const first = { id: 'first', name: 'old', type: 'bpmn' };
        const second = { id: 'second', name: 'second', type: 'bpmn' };
        const replacement = { ...first, name: 'new' };
        const request = jest.fn()
            .mockResolvedValueOnce({ data: { items: [first, second, ...Array(48).fill(first)], total: 100 } })
            .mockResolvedValueOnce({ data: { items: Array(50).fill(replacement), total: 100 } });
        const adapter = new AxiosModelerFileAdapter(undefined, { request } as unknown as AxiosInstance);
        await expect(adapter.findAllFiles('dummy', 'https://example.test')).resolves.toEqual([replacement, second]);
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
            data: { filter: {}, page: 1, size: 50 }, baseURL: 'https://example.test',
            headers: { Accept: 'application/json', Authorization: 'Bearer dummy' },
        }));
    });
});
