import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import axios, { AxiosInstance } from 'axios';
import {
    AxiosModelerFileAdapter,
    createCamundaCli,
    createDownloadFileName,
    defaultModelerApiBaseUrl,
    DownloadFilesUseCase,
    LocalFileAdapter,
    ModelerFile,
    ModelerFileMetadata,
    ModelerFileOutPort,
    ModelerVersion,
    WriteFileOutPort,
} from '../src';

describe('download file name', () => {
    test.each([
        [{ id: '1', name: 'Process', type: 'BPMN' }, 'Process.bpmn'],
        [{ id: '2', name: 'Decision.dmn', type: 'dmn' }, 'Decision.dmn'],
        [{ id: '3', name: '../Purchase/Form', type: 'FORM' }, '.._Purchase_Form.form'],
        [{ id: '4', name: 'Template', type: 'ELEMENT_TEMPLATE' }, 'Template.json'],
        [{ id: '5', name: 'Notes', type: 'MARKDOWN' }, 'Notes.md'],
    ])('creates a safe, type-aware name for %o', (metadata, expectedName) => {
        expect(createDownloadFileName(metadata)).toBe(expectedName);
    });

    test('adds the file ID before the extension when requested', () => {
        expect(createDownloadFileName({ id: 'file-id', name: 'Process', type: 'BPMN' }, true))
            .toBe('Process-file-id.bpmn');
    });

    test('limits long names while preserving the ID and extension', () => {
        const fileName = createDownloadFileName({
            id: 'file-id',
            name: 'P'.repeat(300),
            type: 'BPMN',
        }, true);

        expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255);
        expect(fileName).toMatch(/-file-id[.]bpmn$/);
    });
});

describe('download files use case', () => {
    test('downloads the latest content of every file and disambiguates duplicate names', async () => {
        const firstFile = modelerFile('file-1', 'Order', 'BPMN', '<first />');
        const secondFile = modelerFile('file-2', 'Order', 'BPMN', '<second />');
        const modelerAdapter = new StubModelerFileAdapter([firstFile, secondFile]);
        const fileAdapter = new CapturingFileAdapter();
        const useCase = new DownloadFilesUseCase(modelerAdapter, fileAdapter);

        const downloads = await useCase.downloadFiles({
            bearerToken: ' token ',
            destinationDirectory: '/work',
        });

        expect(modelerAdapter.findAllFilesToken).toBe('token');
        expect(modelerAdapter.getFileCalls).toEqual([
            { bearerToken: 'token', fileId: 'file-1' },
            { bearerToken: 'token', fileId: 'file-2' },
        ]);
        expect(fileAdapter.files).toEqual([
            { destinationDirectory: '/work', fileName: 'Order-file-1.bpmn', content: '<first />' },
            { destinationDirectory: '/work', fileName: 'Order-file-2.bpmn', content: '<second />' },
        ]);
        expect(downloads).toEqual([
            { fileId: 'file-1', path: '/work/Order-file-1.bpmn' },
            { fileId: 'file-2', path: '/work/Order-file-2.bpmn' },
        ]);
    });

    test('uses a custom Modeler API URL for every bulk-download request', async () => {
        const file = modelerFile('file-1', 'Order', 'BPMN', '<latest />');
        const modelerAdapter = new StubModelerFileAdapter([file]);
        const useCase = new DownloadFilesUseCase(modelerAdapter, new CapturingFileAdapter());

        await useCase.downloadFiles({
            bearerToken: 'token',
            destinationDirectory: '/work',
            modelerApiUrl: 'http://localhost:8070/api/v1/',
        });

        expect(modelerAdapter.findAllFilesApiUrl).toBe('http://localhost:8070/api/v1');
        expect(modelerAdapter.getFileApiUrls).toEqual(['http://localhost:8070/api/v1']);
    });

    test('downloads the latest content of a single file by default', async () => {
        const file = modelerFile('file-1', 'Decision', 'DMN', '<latest />');
        const modelerAdapter = new StubModelerFileAdapter([file]);
        const fileAdapter = new CapturingFileAdapter();
        const useCase = new DownloadFilesUseCase(modelerAdapter, fileAdapter);

        await useCase.downloadFile({
            bearerToken: 'token',
            destinationDirectory: '/work',
            fileId: 'file-1',
        });

        expect(modelerAdapter.getVersionCalls).toEqual([]);
        expect(fileAdapter.files).toEqual([
            { destinationDirectory: '/work', fileName: 'Decision.dmn', content: '<latest />' },
        ]);
    });

    test('downloads an explicitly requested version of a single file', async () => {
        const file = modelerFile('file-1', 'Task form', 'FORM', '{"latest":true}');
        const version: ModelerVersion = {
            metadata: { id: 'version-1', fileId: 'file-1' },
            content: '{"version":1}',
        };
        const modelerAdapter = new StubModelerFileAdapter([file], [version]);
        const fileAdapter = new CapturingFileAdapter();
        const useCase = new DownloadFilesUseCase(modelerAdapter, fileAdapter);

        await useCase.downloadFile({
            bearerToken: 'token',
            destinationDirectory: '/work',
            fileId: 'file-1',
            modelerApiUrl: 'https://self-hosted.test/api/v1/',
            versionId: 'version-1',
        });

        expect(modelerAdapter.getFileApiUrls).toEqual(['https://self-hosted.test/api/v1']);
        expect(modelerAdapter.getVersionCalls).toEqual([
            { bearerToken: 'token', versionId: 'version-1' },
        ]);
        expect(modelerAdapter.getVersionApiUrls).toEqual(['https://self-hosted.test/api/v1']);
        expect(fileAdapter.files).toEqual([
            { destinationDirectory: '/work', fileName: 'Task form.form', content: '{"version":1}' },
        ]);
    });

    test('rejects a version belonging to another file', async () => {
        const file = modelerFile('file-1', 'Process', 'BPMN', '<latest />');
        const version: ModelerVersion = {
            metadata: { id: 'version-1', fileId: 'file-2' },
            content: '<version />',
        };
        const fileAdapter = new CapturingFileAdapter();
        const useCase = new DownloadFilesUseCase(
            new StubModelerFileAdapter([file], [version]),
            fileAdapter,
        );

        await expect(useCase.downloadFile({
            bearerToken: 'token',
            destinationDirectory: '/work',
            fileId: 'file-1',
            versionId: 'version-1',
        })).rejects.toThrow('Version version-1 does not belong to file file-1.');
        expect(fileAdapter.files).toEqual([]);
    });

    test('rejects a blank bearer token before calling the API', async () => {
        const modelerAdapter = new StubModelerFileAdapter([]);
        const useCase = new DownloadFilesUseCase(modelerAdapter, new CapturingFileAdapter());

        await expect(useCase.downloadFiles({
            bearerToken: '  ',
            destinationDirectory: '/work',
        })).rejects.toThrow('A bearer token is required.');
        expect(modelerAdapter.findAllFilesToken).toBeUndefined();
    });

    test('rejects a blank requested version instead of downloading the latest content', async () => {
        const file = modelerFile('file-1', 'Process', 'BPMN', '<latest />');
        const modelerAdapter = new StubModelerFileAdapter([file]);
        const useCase = new DownloadFilesUseCase(modelerAdapter, new CapturingFileAdapter());

        await expect(useCase.downloadFile({
            bearerToken: 'token',
            destinationDirectory: '/work',
            fileId: 'file-1',
            versionId: ' ',
        })).rejects.toThrow('A version ID is required.');
        expect(modelerAdapter.getVersionCalls).toEqual([]);
    });

    test.each([
        'file:///tmp/modeler',
        'https://user:password@example.test/api/v1',
        'https://example.test/api/v1?',
        'https://example.test/api/v1#',
    ])('rejects the invalid custom Modeler API URL %s before calling the API', async (modelerApiUrl) => {
        const modelerAdapter = new StubModelerFileAdapter([]);
        const useCase = new DownloadFilesUseCase(modelerAdapter, new CapturingFileAdapter());

        await expect(useCase.downloadFiles({
            bearerToken: 'token',
            destinationDirectory: '/work',
            modelerApiUrl,
        })).rejects.toThrow(`Invalid Modeler API URL: ${modelerApiUrl}`);
        expect(modelerAdapter.findAllFilesToken).toBeUndefined();
    });
});

describe('Axios Modeler file adapter', () => {
    test('uses the Camunda API default and allows a configured bootstrap default', () => {
        const request = jest.fn();
        const httpClient = { request } as unknown as AxiosInstance;
        const create = jest.spyOn(axios, 'create').mockReturnValue(httpClient);

        try {
            new AxiosModelerFileAdapter();
            new AxiosModelerFileAdapter('http://localhost:8070/api/v1');

            expect(create).toHaveBeenNthCalledWith(1, { baseURL: defaultModelerApiBaseUrl });
            expect(create).toHaveBeenNthCalledWith(2, { baseURL: 'http://localhost:8070/api/v1' });
        } finally {
            create.mockRestore();
        }
    });

    test('paginates file search requests and sends the bearer token on every request', async () => {
        const firstPage = Array.from({ length: 50 }, (_, index) => modelerMetadata(`file-${index}`));
        const lastFile = modelerMetadata('file-50');
        const request = jest.fn()
            .mockResolvedValueOnce({ data: { items: firstPage, total: 51 } })
            .mockResolvedValueOnce({ data: { items: [lastFile], total: 51 } });
        const adapter = new AxiosModelerFileAdapter('https://example.test/api/v1', { request } as unknown as AxiosInstance);

        const files = await adapter.findAllFiles('jwt', 'http://self-hosted.test/api/v1');

        expect(files).toHaveLength(51);
        expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: 'POST',
            url: '/files/search',
            data: { filter: {}, page: 0, size: 50 },
            baseURL: 'http://self-hosted.test/api/v1',
            headers: { Accept: 'application/json', Authorization: 'Bearer jwt' },
        }));
        expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
            data: { filter: {}, page: 1, size: 50 },
            baseURL: 'http://self-hosted.test/api/v1',
            headers: { Accept: 'application/json', Authorization: 'Bearer jwt' },
        }));
    });

    test('uses the documented endpoints for latest files and exact versions', async () => {
        const request = jest.fn()
            .mockResolvedValueOnce({ data: modelerFile('file/1', 'Process', 'BPMN', '<latest />') })
            .mockResolvedValueOnce({
                data: { metadata: { id: 'version/1', fileId: 'file/1' }, content: '<version />' },
            });
        const adapter = new AxiosModelerFileAdapter('https://example.test/api/v1', { request } as unknown as AxiosInstance);

        await adapter.getFile('jwt', 'file/1');
        await adapter.getVersion('jwt', 'version/1');

        expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: 'GET',
            url: '/files/file%2F1',
            headers: { Accept: 'application/json', Authorization: 'Bearer jwt' },
        }));
        expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'GET',
            url: '/versions/version%2F1',
            headers: { Accept: 'application/json', Authorization: 'Bearer jwt' },
        }));
        expect(request.mock.calls[0][0]).not.toHaveProperty('baseURL');
        expect(request.mock.calls[1][0]).not.toHaveProperty('baseURL');
    });
});

describe('local file adapter', () => {
    test('writes downloaded content to the destination directory', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'camunda-cli-'));

        try {
            const outputPath = await new LocalFileAdapter().writeFile(directory, 'Process.bpmn', '<process />');

            expect(outputPath).toBe(path.join(directory, 'Process.bpmn'));
            await expect(readFile(outputPath, 'utf8')).resolves.toBe('<process />');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('atomically replaces an existing regular file', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'camunda-cli-'));
        const outputPath = path.join(directory, 'Process.bpmn');

        try {
            await writeFile(outputPath, '<old />');
            await new LocalFileAdapter().writeFile(directory, 'Process.bpmn', '<latest />');

            await expect(readFile(outputPath, 'utf8')).resolves.toBe('<latest />');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('does not follow an existing output symlink', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'camunda-cli-'));
        const linkedFile = path.join(directory, 'linked.bpmn');
        const outputPath = path.join(directory, 'Process.bpmn');

        try {
            await writeFile(linkedFile, '<outside />');
            await symlink(linkedFile, outputPath);

            await expect(new LocalFileAdapter().writeFile(directory, 'Process.bpmn', '<latest />'))
                .rejects.toThrow('Refusing to replace a symbolic link');
            await expect(readFile(linkedFile, 'utf8')).resolves.toBe('<outside />');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('rejects output paths outside the destination directory', async () => {
        await expect(new LocalFileAdapter().writeFile('/work', '../Process.bpmn', '<process />'))
            .rejects.toThrow('Refusing to write outside the destination directory');
    });
});

describe('download CLI commands', () => {
    test('forwards the bearer token and custom API URL when downloading all files', async () => {
        const downloadFiles = jest.fn().mockResolvedValue([]);
        const downloadFile = jest.fn();
        const program = createCamundaCli({
            downloadFilesInPort: { downloadFiles, downloadFile },
            sayHelloWorldInPort: { sayHelloWorld: jest.fn() },
        });

        await program.parseAsync([
            'download',
            'files',
            '--bearer-token',
            'jwt',
            '--destination-directory',
            '/downloads',
            '--modeler-api-url',
            'http://localhost:8070/api/v1',
        ], { from: 'user' });

        expect(downloadFiles).toHaveBeenCalledWith({
            bearerToken: 'jwt',
            destinationDirectory: '/downloads',
            modelerApiUrl: 'http://localhost:8070/api/v1',
        });
    });

    test('forwards file and version IDs when downloading one file', async () => {
        const downloadFiles = jest.fn();
        const downloadFile = jest.fn().mockResolvedValue({ fileId: 'file-1', path: '/work/Process.bpmn' });
        const program = createCamundaCli({
            downloadFilesInPort: { downloadFiles, downloadFile },
            sayHelloWorldInPort: { sayHelloWorld: jest.fn() },
        });

        await program.parseAsync([
            'download',
            'file',
            'file-1',
            '--version-id',
            'version-1',
            '--bearer-token',
            'jwt',
            '-d',
            '/single-download',
            '--modeler-api-url',
            'http://localhost:8070/api/v1',
        ], { from: 'user' });

        expect(downloadFile).toHaveBeenCalledWith({
            bearerToken: 'jwt',
            destinationDirectory: '/single-download',
            fileId: 'file-1',
            modelerApiUrl: 'http://localhost:8070/api/v1',
            versionId: 'version-1',
        });
    });

    test('uses the current directory by default when downloading one file', async () => {
        const downloadFile = jest.fn().mockResolvedValue({ fileId: 'file-1', path: '/work/Process.bpmn' });
        const program = createCamundaCli({
            downloadFilesInPort: { downloadFiles: jest.fn(), downloadFile },
            sayHelloWorldInPort: { sayHelloWorld: jest.fn() },
        });

        await program.parseAsync([
            'download',
            'file',
            'file-1',
            '--bearer-token',
            'jwt',
        ], { from: 'user' });

        expect(downloadFile).toHaveBeenCalledWith({
            bearerToken: 'jwt',
            destinationDirectory: process.cwd(),
            fileId: 'file-1',
            modelerApiUrl: undefined,
            versionId: undefined,
        });
    });

    test('accepts the bearer token from the environment', async () => {
        const previousToken = process.env.CAMUNDA_MODELER_BEARER_TOKEN;
        const downloadFiles = jest.fn().mockResolvedValue([]);
        const program = createCamundaCli({
            downloadFilesInPort: { downloadFiles, downloadFile: jest.fn() },
            sayHelloWorldInPort: { sayHelloWorld: jest.fn() },
        });

        process.env.CAMUNDA_MODELER_BEARER_TOKEN = 'environment-jwt';

        try {
            await program.parseAsync(['download', 'files'], { from: 'user' });
        } finally {
            if (previousToken === undefined) {
                delete process.env.CAMUNDA_MODELER_BEARER_TOKEN;
            } else {
                process.env.CAMUNDA_MODELER_BEARER_TOKEN = previousToken;
            }
        }

        expect(downloadFiles).toHaveBeenCalledWith({
            bearerToken: 'environment-jwt',
            destinationDirectory: process.cwd(),
            modelerApiUrl: undefined,
        });
    });
});

function modelerMetadata(id: string, name = 'Process', type = 'BPMN'): ModelerFileMetadata {
    return { id, name, type };
}

function modelerFile(id: string, name: string, type: string, content: string): ModelerFile {
    return { metadata: modelerMetadata(id, name, type), content };
}

class StubModelerFileAdapter implements ModelerFileOutPort {
    findAllFilesToken: string | undefined;
    findAllFilesApiUrl: string | undefined;
    getFileCalls: Array<{ bearerToken: string; fileId: string }> = [];
    getFileApiUrls: Array<string | undefined> = [];
    getVersionCalls: Array<{ bearerToken: string; versionId: string }> = [];
    getVersionApiUrls: Array<string | undefined> = [];

    constructor(
        private readonly files: ModelerFile[],
        private readonly versions: ModelerVersion[] = [],
    ) {}

    async findAllFiles(bearerToken: string, modelerApiUrl?: string): Promise<ModelerFileMetadata[]> {
        this.findAllFilesToken = bearerToken;
        this.findAllFilesApiUrl = modelerApiUrl;
        return this.files.map((file) => file.metadata);
    }

    async getFile(bearerToken: string, fileId: string, modelerApiUrl?: string): Promise<ModelerFile> {
        this.getFileCalls.push({ bearerToken, fileId });
        this.getFileApiUrls.push(modelerApiUrl);
        const file = this.files.find((candidate) => candidate.metadata.id === fileId);

        if (!file) {
            throw new Error(`File not found: ${fileId}`);
        }

        return file;
    }

    async getVersion(bearerToken: string, versionId: string, modelerApiUrl?: string): Promise<ModelerVersion> {
        this.getVersionCalls.push({ bearerToken, versionId });
        this.getVersionApiUrls.push(modelerApiUrl);
        const version = this.versions.find((candidate) => candidate.metadata.id === versionId);

        if (!version) {
            throw new Error(`Version not found: ${versionId}`);
        }

        return version;
    }
}

class CapturingFileAdapter implements WriteFileOutPort {
    files: Array<{ destinationDirectory: string; fileName: string; content: string }> = [];

    async writeFile(destinationDirectory: string, fileName: string, content: string): Promise<string> {
        this.files.push({ destinationDirectory, fileName, content });
        return path.join(destinationDirectory, fileName);
    }
}
