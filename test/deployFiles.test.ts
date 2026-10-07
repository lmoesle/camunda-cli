import axios, { AxiosInstance } from 'axios';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    AxiosDeploymentAdapter, ConsoleDeploymentsPresenter, createCamundaCli, createDefaultCamundaCli,
    DeploymentConnection, DeployFilesUseCase, JsonProfileRepositoryAdapter, LocalDeploymentFilesAdapter, Profile,
} from '../src';

const local: Profile = { name: 'selected', baseUrl: 'http://localhost:8080/proxy/cluster/' };
const oauth = { oAuthUrl: 'https://auth.example/token', clientId: ' dummy+client ', clientSecret: ' dummy+secret&= / ' };
const connection: DeploymentConnection = { deploymentsUrl: 'https://gateway.example/proxy/v2/deployments', oauth };
const resource = { filename: 'test.bpmn', bytes: new Uint8Array([0, 255, 13, 10]) };

function mockHttp(): { adapter: AxiosDeploymentAdapter; post: jest.Mock } {
    const post = jest.fn();
    return { adapter: new AxiosDeploymentAdapter({ post } as unknown as AxiosInstance), post };
}

function orchestration(profile: Profile | undefined = local) {
    const files = { discover: jest.fn().mockResolvedValue(['a.bpmn', 'b.dmn', 'c.form']), read: jest.fn().mockResolvedValue(resource) };
    const deploy = jest.fn().mockResolvedValue('9007199254740993');
    const connect = jest.fn().mockResolvedValue({ deploy });
    const presenter = { showDeployed: jest.fn(), showSummary: jest.fn() };
    const getProfile = jest.fn((name: string) => name === 'selected' ? profile : undefined);
    return { files, deploy, connect, presenter, getProfile,
        usecase: new DeployFilesUseCase({ getProfile }, files, { connect }, presenter) };
}

describe('deployment orchestration and profile validation', () => {
    test.each(['http://localhost:8080/proxy/cluster/', 'http://localhost:8080/proxy/cluster/v2///'])(
        'normalizes only profile name and endpoint %s', async (baseUrl) => {
            const state = orchestration({ ...local, baseUrl, ...oauth, oAuthUrl: ' https://auth.example/token/ ', audience: ' audience+bytes ' });
            await state.usecase.deployFiles({ profile: ' selected ', path: 'models', recursive: true });
            expect(state.getProfile).toHaveBeenCalledWith('selected');
            expect(state.connect).toHaveBeenCalledWith({ deploymentsUrl: 'http://localhost:8080/proxy/cluster/v2/deployments',
                oauth: { ...oauth, audience: ' audience+bytes ' } });
            expect(state.files.discover).toHaveBeenCalledWith('models', true);
            expect(state.deploy).toHaveBeenCalledTimes(3);
            expect(state.presenter.showSummary).toHaveBeenCalledWith(3);
        },
    );

    test.each([' ', 'Selected', 'unknown'])('rejects unknown/blank case-sensitive profile %j before discovery', async (profile) => {
        const state = orchestration();
        await expect(state.usecase.deployFiles({ profile, path: 'models' })).rejects.toThrow(/profile/);
        expect(state.files.discover).not.toHaveBeenCalled();
        expect(state.connect).not.toHaveBeenCalled();
    });

    test.each([
        { baseUrl: 'bad' }, { baseUrl: 'ftp://host' }, { baseUrl: 'https://dummy:secret@host' },
        { baseUrl: 'https://host?secret' }, { baseUrl: 'https://host#secret' }, { baseUrl: 'https://host?' },
        { baseUrl: 'https://host#' }, { clientId: 'only' }, { audience: 'only' },
        { ...oauth, clientId: '' }, { ...oauth, clientSecret: ' \t ' }, { ...oauth, oAuthUrl: ' ' },
        { ...oauth, oAuthUrl: 'https://dummy:secret@host' }, { ...oauth, audience: '' },
        { ...oauth, audience: undefined }, { ...oauth, baseUrl: 'https://bru-1.zeebe.camunda.io/cluster' },
        { ...oauth, oAuthUrl: 'https://login.cloud.camunda.io/oauth/token' },
    ])('rejects invalid configuration %j before any HTTP', async (overrides) => {
        const state = orchestration({ ...local, ...overrides });
        await expect(state.usecase.deployFiles({ profile: 'selected', path: 'models' })).rejects.toThrow(/Profile/);
        expect(state.connect).not.toHaveBeenCalled();
        expect(state.files.discover).not.toHaveBeenCalled();
    });

    test('no OAuth properties means no auth and discovery failure precedes network', async () => {
        const state = orchestration();
        await state.usecase.deployFiles({ profile: 'selected', path: 'models' });
        expect(state.connect).toHaveBeenCalledWith({ deploymentsUrl: 'http://localhost:8080/proxy/cluster/v2/deployments' });
        state.connect.mockClear();
        state.files.discover.mockRejectedValueOnce(new Error('no files'));
        await expect(state.usecase.deployFiles({ profile: 'selected', path: 'models' })).rejects.toThrow('no files');
        expect(state.connect).not.toHaveBeenCalled();
    });

    test('deploys sequentially, reports successes immediately, and stops on a later failure', async () => {
        const state = orchestration();
        state.deploy.mockImplementationOnce(async () => {
            expect(state.files.read).toHaveBeenCalledTimes(1);
            return '1';
        }).mockImplementationOnce(async () => {
            expect(state.presenter.showDeployed).toHaveBeenCalledWith('a.bpmn', '1');
            throw Object.assign(new Error('Resource deployment failed (HTTP 403).'), {
                config: { headers: { Authorization: 'dummy-secret' } },
            });
        });
        const result = state.usecase.deployFiles({ profile: 'selected', path: 'models' });
        await expect(result).rejects.toThrow(
            /b.dmn after 1 successful deployment.*remain committed.*uncertain.*HTTP 403/,
        );
        await expect(result).rejects.not.toHaveProperty('cause');
        await expect(result).rejects.not.toHaveProperty('config');
        expect(state.files.read).toHaveBeenCalledTimes(2);
        expect(state.deploy).toHaveBeenCalledTimes(2);
        expect(state.presenter.showSummary).not.toHaveBeenCalled();
    });
});

describe('local deployment discovery and reads', () => {
    let directory: string;
    const files = new LocalDeploymentFilesAdapter();
    beforeEach(async () => { directory = await fs.mkdtemp(path.join(tmpdir(), 'cli-deploy-')); });
    afterEach(async () => { jest.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

    test('shallow vs recursive discovery filters exact suffixes, sorts paths, and skips symlink cycles', async () => {
        await fs.mkdir(path.join(directory, 'nested'));
        for (const name of ['z.form', 'a.bpmn', 'b.dmn', 'ignored.BPMN', 'other.txt', 'nested/a.bpmn']) {
            await fs.writeFile(path.join(directory, name), name);
        }
        await fs.symlink(directory, path.join(directory, 'nested/cycle'));
        await fs.symlink(path.join(directory, 'a.bpmn'), path.join(directory, 'link.bpmn'));
        expect(await files.discover(directory, false)).toEqual(['a.bpmn', 'b.dmn', 'z.form'].map((name) => path.join(directory, name)));
        expect(await files.discover(directory, true)).toEqual(['a.bpmn', 'b.dmn', 'nested/a.bpmn', 'z.form'].map((name) => path.join(directory, name)));
        for (const name of ['a.bpmn', 'b.dmn', 'z.form']) {
            const filePath = path.join(directory, name);
            expect(await files.discover(filePath, false)).toEqual([filePath]);
            expect(await files.read(filePath)).toEqual({ filename: name, bytes: Buffer.from(name) });
        }
        await expect(files.discover(path.join(directory, 'link.bpmn'), false)).rejects.toThrow(/symlink/);
        await expect(files.read(path.join(directory, 'link.bpmn'))).rejects.toThrow(/non-symlink/);
    });

    test('keeps relative paths, original Unicode/spaced basenames, and exact binary bytes', async () => {
        const filePath = path.join(directory, 'space ü.form');
        const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('é\r\n'), Buffer.from([0, 255])]);
        await fs.writeFile(filePath, bytes);
        const relative = path.relative(process.cwd(), filePath);
        expect(await files.discover(relative, true)).toEqual([relative]);
        expect(await files.read(relative)).toEqual({ filename: 'space ü.form', bytes });
    });

    test('rejects empty/no-match folders, unsupported and missing inputs', async () => {
        await expect(files.discover(directory, false)).rejects.toThrow(/No supported/);
        const unsupported = path.join(directory, 'test.BPMN');
        await fs.writeFile(unsupported, 'ignored');
        await expect(files.discover(unsupported, false)).rejects.toThrow(/Unsupported/);
        await expect(files.discover(directory, true)).rejects.toThrow(/No supported/);
        await expect(files.discover(path.join(directory, 'missing'), false)).rejects.toThrow(/missing or unreadable/);
    });

    test('rejects special input without opening it', async () => {
        const stat = await fs.lstat(directory);
        jest.spyOn(fs, 'lstat').mockResolvedValueOnce(Object.assign(stat, { isFile: () => false, isDirectory: () => false }));
        const open = jest.spyOn(fs, 'open');
        await expect(files.discover('special', false)).rejects.toThrow(/regular file or directory/);
        expect(open).not.toHaveBeenCalled();
    });

    test('fails safely on unreadable discovery/read and disappearance after discovery', async () => {
        const filePath = path.join(directory, 'test.bpmn');
        await fs.writeFile(filePath, 'bytes');
        jest.spyOn(fs, 'access').mockRejectedValueOnce(Object.assign(new Error('unsafe filename\n'), { code: 'EACCES' }));
        const discovery = files.discover(filePath, false);
        await expect(discovery).rejects.toThrow(/missing or unreadable/);
        await expect(discovery).rejects.not.toHaveProperty('cause');
        expect(await files.discover(filePath, false)).toEqual([filePath]);
        jest.spyOn(fs, 'open').mockRejectedValueOnce(new Error('unsafe details'));
        await expect(files.read(filePath)).rejects.toThrow(/missing or unreadable/);
        await fs.rm(filePath);
        const state = orchestration();
        state.files.discover.mockResolvedValueOnce([filePath]);
        state.files.read.mockImplementationOnce(() => files.read(filePath));
        await expect(state.usecase.deployFiles({ profile: 'selected', path: filePath })).rejects.toThrow(/after 0 successful.*Cannot read/);
        expect(state.deploy).not.toHaveBeenCalled();
    });
});

describe('deployment HTTP session', () => {
    test('authenticates once per invocation, preserves credential encoding, and never shares tokens with no-auth sessions', async () => {
        const { adapter, post } = mockHttp();
        post.mockResolvedValueOnce({ data: '{"access_token":"dummy.token+/="}' });
        const session = await adapter.connect({ ...connection, oauth: { ...oauth, audience: ' original audience ' } });
        post.mockResolvedValue({ data: '{"deploymentKey":9007199254740993}' });
        expect(await session.deploy(resource)).toBe('9007199254740993');
        expect(await session.deploy(resource)).toBe('9007199254740993');
        expect(Object.fromEntries(new URLSearchParams(post.mock.calls[0][1]))).toEqual({ grant_type: 'client_credentials',
            client_id: oauth.clientId, client_secret: oauth.clientSecret, audience: ' original audience ' });
        expect(post.mock.calls[1][1]).not.toBe(post.mock.calls[2][1]);
        expect(post.mock.calls[1][2].headers.Authorization).toBe('Bearer dummy.token+/=');
        const noAuth = await adapter.connect({ deploymentsUrl: connection.deploymentsUrl });
        await noAuth.deploy(resource);
        expect(post.mock.calls[3][2].headers).not.toHaveProperty('Authorization');
        post.mockResolvedValueOnce({ data: '{"access_token":"fresh"}' });
        await adapter.connect(connection);
        expect(post).toHaveBeenCalledTimes(5);
        for (const call of post.mock.calls) expect(call[2]).toMatchObject({ timeout: 30000, maxRedirects: 0, responseType: 'text' });
    });

    test.each(['{}', '{"access_token":""}', '{"access_token":"dummy\\r\\nsecret"}', '{"access_token":12}', 'dummy-secret'])(
        'rejects malformed token safely without deploying %s', async (data) => {
            const { adapter, post } = mockHttp();
            post.mockResolvedValueOnce({ data });
            await expect(adapter.connect(connection)).rejects.toThrow(/OAuth authentication/);
            expect(post).toHaveBeenCalledTimes(1);
        },
    );

    test.each(['{}', '{"deploymentKey":1.5}', '{"deploymentKey":9223372036854775808}', '{"deploymentKey":"bad"}', 'dummy-secret'])(
        'rejects malformed deployment response %s', async (data) => {
            const { adapter, post } = mockHttp();
            const session = await adapter.connect({ deploymentsUrl: connection.deploymentsUrl });
            post.mockResolvedValueOnce({ data });
            await expect(session.deploy(resource)).rejects.toThrow(/malformed/);
            expect(post).toHaveBeenCalledTimes(1);
        },
    );

    test.each(['9007199254740993', '9223372036854775807'])('preserves numeric and string int64 key %s', async (key) => {
        const { adapter, post } = mockHttp();
        const session = await adapter.connect({ deploymentsUrl: connection.deploymentsUrl });
        for (const raw of [key, `"${key}"`]) {
            post.mockResolvedValueOnce({ data: `{"deploymentKey":${raw}}` });
            expect(await session.deploy(resource)).toBe(key);
        }
    });

    test.each([undefined, 401, 403, 302, 500])('sanitizes network/HTTP %j without retries', async (status) => {
        const { adapter, post } = mockHttp();
        post.mockRejectedValue(Object.assign(new Error('dummy-secret dummy-token'), { isAxiosError: true,
            response: status ? { status, data: 'dummy-secret' } : undefined,
            config: { data: 'dummy-secret', headers: { Authorization: 'dummy-token' } } }));
        const authentication = adapter.connect(connection);
        await expect(authentication).rejects.toThrow(/OAuth authentication failed/);
        await expect(authentication).rejects.not.toHaveProperty('cause');
        await expect(authentication).rejects.not.toHaveProperty('config');
        await expect(authentication).rejects.not.toHaveProperty('response');
        const session = await adapter.connect({ deploymentsUrl: connection.deploymentsUrl });
        const deployment = session.deploy(resource);
        await expect(deployment).rejects.toThrow(/Resource deployment failed/);
        await expect(deployment).rejects.not.toHaveProperty('cause');
        await expect(deployment).rejects.not.toHaveProperty('config');
        await expect(deployment).rejects.not.toHaveProperty('response');
        await expect(session.deploy(resource)).rejects.not.toThrow(/dummy-secret|dummy-token/);
        expect(post).toHaveBeenCalledTimes(3);
        if (status) await expect(session.deploy(resource)).rejects.toThrow(`HTTP ${status}`);
    });
});

describe('real Axios multipart requests and cached CLI runtime', () => {
    let server: Server;
    let home: string;
    let root: string;
    let requests: { url: string; authorization?: string; contentType: string; body: Buffer }[];
    let failAt: number | undefined;
    let redirect: boolean;
    beforeEach(async () => {
        home = await fs.mkdtemp(path.join(tmpdir(), 'cli-deploy-http-'));
        requests = [];
        failAt = undefined;
        redirect = false;
        server = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                requests.push({ url: request.url!, authorization: request.headers.authorization,
                    contentType: request.headers['content-type']!, body: Buffer.concat(chunks) });
                response.setHeader('Content-Type', 'application/json');
                if (redirect) {
                    response.statusCode = 302;
                    response.setHeader('Location', '/should-not-follow');
                    response.end('dummy-secret');
                } else if (request.url === '/token') response.end('{"access_token":"loopback-dummy"}');
                else if (requests.filter((item) => item.url !== '/token').length === failAt) {
                    response.statusCode = 403;
                    response.end('dummy-secret');
                } else response.end('{"deploymentKey":9007199254740993}');
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await fs.rm(home, { recursive: true, force: true });
    });

    test.each([false, true])('N resources each produce a distinct one-part multipart POST (OAuth=%j)', async (authenticated) => {
        const directory = path.join(home, 'models');
        await fs.mkdir(path.join(directory, 'nested'), { recursive: true });
        const names = ['a.bpmn', 'nested/a.bpmn', 'space ü.dmn', 'z.form'];
        const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('é\r\n'), Buffer.from([0, 255])]);
        for (const name of names) await fs.writeFile(path.join(directory, name), bytes);
        const profile = { ...local, baseUrl: `${root}/proxy/cluster/v2/`,
            ...(authenticated ? { ...oauth, oAuthUrl: `${root}/token` } : {}) };
        const output = jest.fn();
        const usecase = new DeployFilesUseCase({ getProfile: () => profile }, new LocalDeploymentFilesAdapter(),
            new AxiosDeploymentAdapter(axios.create({ proxy: false })), new ConsoleDeploymentsPresenter(output));
        await usecase.deployFiles({ path: directory, profile: 'selected', recursive: true });
        expect(requests.filter((item) => item.url === '/token')).toHaveLength(authenticated ? 1 : 0);
        const deployments = requests.filter((item) => item.url !== '/token');
        expect(deployments).toHaveLength(names.length);
        for (const [index, request] of deployments.entries()) {
            expect(request.url).toBe('/proxy/cluster/v2/deployments');
            expect(request.authorization).toBe(authenticated ? 'Bearer loopback-dummy' : undefined);
            const boundary = request.contentType.split('boundary=')[1];
            expect(boundary).toBeTruthy();
            const text = request.body.toString('utf8');
            expect(text.match(/name="resources"/g)).toHaveLength(1);
            expect(text).toContain(`filename="${path.basename(names[index])}"`);
            expect(request.body.indexOf(bytes)).toBeGreaterThan(0);
            const start = request.body.indexOf(Buffer.from('\r\n\r\n')) + 4;
            expect(request.body.subarray(start, start + bytes.length)).toEqual(bytes);
            expect(request.body.subarray(start + bytes.length).toString()).toBe(`\r\n--${boundary}--\r\n`);
        }
        expect(output.mock.calls[0][0]).toContain('9007199254740993');
        expect(output.mock.calls[output.mock.calls.length - 1][0]).toBe('Successfully deployed 4 file(s)');
    });

    test('later HTTP failure retains progress and sends no request for remaining files', async () => {
        for (const name of ['a.bpmn', 'b.dmn', 'c.form']) await fs.writeFile(path.join(home, name), 'bytes');
        failAt = 2;
        const output = jest.fn();
        const usecase = new DeployFilesUseCase({ getProfile: () => ({ ...local, baseUrl: root }) }, new LocalDeploymentFilesAdapter(),
            new AxiosDeploymentAdapter(axios.create({ proxy: false })), new ConsoleDeploymentsPresenter(output));
        await expect(usecase.deployFiles({ profile: 'selected', path: home })).rejects.toThrow(/b.dmn after 1.*HTTP 403/);
        expect(requests).toHaveLength(2);
        expect(output).toHaveBeenCalledTimes(1);
    });

    test('real OAuth and deployment redirects do not follow or retry', async () => {
        redirect = true;
        const adapter = new AxiosDeploymentAdapter(axios.create({ proxy: false }));
        await expect(adapter.connect({ deploymentsUrl: `${root}/v2/deployments`, oauth: { ...oauth, oAuthUrl: `${root}/token` } }))
            .rejects.toThrow('OAuth authentication failed (HTTP 302)');
        const session = await adapter.connect({ deploymentsUrl: `${root}/v2/deployments` });
        await expect(session.deploy(resource)).rejects.toThrow('Resource deployment failed (HTTP 302)');
        expect(requests.map((request) => request.url)).toEqual(['/token', '/v2/deployments']);
    });

    test('default runtime routes deploy startup notices to diagnostics, including preAction validation errors', async () => {
        const output = jest.fn();
        const diagnostics = jest.fn();
        const cli = createDefaultCamundaCli({ homeDirectory: home, writeLine: output, writeDiagnostic: diagnostics });
        await expect(cli.parseAsync(['node', 'cli', 'deploy', 'missing', '--profile', 'unknown'])).rejects.toThrow(/profile does not exist/);
        expect(output).not.toHaveBeenCalled();
        expect(diagnostics).toHaveBeenCalled();
        expect(requests).toHaveLength(0);
    });

    test('default runtime uses the initialized cache rather than reloading profiles', async () => {
        const repository = new JsonProfileRepositoryAdapter(home);
        await repository.addProfile({ ...local, baseUrl: root });
        const output = jest.fn();
        const cli = createDefaultCamundaCli({ homeDirectory: home, writeLine: output, writeDiagnostic: jest.fn() });
        await cli.initialize();
        const filePath = path.join(home, 'cached.form');
        await fs.writeFile(filePath, '{}');
        await fs.rm(path.join(home, '.lmoesle-camunda-cli', 'profiles.json'));
        await cli.initialize();
        await cli.parseAsync(['node', 'cli', 'deploy', filePath, '--profile', ' selected ']);
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe('/v2/deployments');
        expect(output.mock.calls[output.mock.calls.length - 1][0]).toBe('Successfully deployed 1 file(s)');
    });
});

describe('deploy CLI and terminal presentation', () => {
    function cli(deployFiles = jest.fn()) {
        const program = createCamundaCli({ deployFilesInPort: { deployFiles } });
        for (const command of [program, ...program.commands]) command.exitOverride().configureOutput({ writeErr: jest.fn() });
        return { deployFiles, program };
    }

    test.each(['-r', '--recursive'])('parses path and recursion alias %s', async (alias) => {
        const { program, deployFiles } = cli();
        await program.parseAsync(['node', 'cli', 'deploy', 'space ü/path', '--profile', 'selected', alias]);
        expect(deployFiles).toHaveBeenCalledWith({ path: 'space ü/path', profile: 'selected', recursive: true });
    });

    test.each([{ args: ['deploy', '--profile', 'selected'] }, { args: ['deploy', 'models'] }])('requires positional path and profile $args', async ({ args }) => {
        const { program, deployFiles } = cli();
        await expect(program.parseAsync(['node', 'cli', ...args])).rejects.toThrow();
        expect(deployFiles).not.toHaveBeenCalled();
    });

    test('optional dependency keeps existing commands usable and gives a clear deployment error', async () => {
        const addProfile = jest.fn();
        const program = createCamundaCli({ addProfileInPort: { addProfile } });
        await program.parseAsync(['node', 'cli', 'add', 'profile', '--name', 'local', '--base-url', 'xxx']);
        expect(addProfile).toHaveBeenCalledWith({ name: 'local', baseUrl: 'xxx', oAuthUrl: undefined });
        await expect(program.parseAsync(['node', 'cli', 'deploy', 'models', '--profile', 'selected'])).rejects.toThrow('DeployFilesInPort');
    });

    test('escapes terminal controls in successful and failed paths', async () => {
        const filePath = 'a\n\u001b[31m\u202e.bpmn';
        const output = jest.fn();
        new ConsoleDeploymentsPresenter(output).showDeployed(filePath, '1');
        expect(output.mock.calls[0][0]).toContain('a\\u000a\\u001b[31m\\u202e.bpmn');
        const state = orchestration();
        state.files.discover.mockResolvedValueOnce([filePath]);
        state.deploy.mockRejectedValueOnce(new Error('Resource deployment failed.'));
        await expect(state.usecase.deployFiles({ path: 'models', profile: 'selected' })).rejects.toThrow('a\\u000a\\u001b[31m\\u202e.bpmn');
    });
});
