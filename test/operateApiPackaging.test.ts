import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

test('dist-only executable and library embed the spec and generated clients without source files or node_modules', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'cli-api-package-'));
    const output = path.join(home, 'package');
    try {
        // Compile current sources, not a potentially stale dist. The output lives
        // outside the repository so Node cannot resolve source or dependencies.
        const build = spawnSync(process.execPath, [require.resolve('webpack-cli/bin/cli.js'),
            '--output-path', output, '--no-stats'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
        expect(build.error).toBeUndefined();
        expect({ status: build.status, stderr: build.stderr }).toEqual({ status: 0, stderr: '' });
        const env = { ...process.env, HOME: home, USERPROFILE: home, NODE_PATH: '' };
        const executable = spawnSync(process.execPath, [path.join(output, 'bin/camunda-cli.js'), 'api', 'ls'], {
            cwd: home, env, encoding: 'utf8', timeout: 10000,
        });
        expect(executable.status).toBe(0);
        expect(JSON.parse(executable.stdout)).toHaveLength(21);
        const library = spawnSync(process.execPath, ['-e', `
            const api = require(${JSON.stringify(path.join(output, 'index.js'))});
            const prepared = api.prepareOperateRequest('byKey', '{"path":{"key":9223372036854775807}}');
            const requests = [];
            const adapter = new api.AxiosOperateApiAdapter({request: async (options) => {
                requests.push(options);
                return {status: 200, headers: {'content-type': 'application/json'},
                    data: options.url.endsWith('/token') ? '{"access_token":"dummy-token"}' : '{"key":9007199254740993}'};
            }});
            adapter.execute({operateUrl: 'https://operate.invalid/prefix/v1', oAuthUrl: 'https://oauth.invalid/token',
                clientId: 'dummy-id', clientSecret: 'dummy-secret'}, prepared).then(() => {
                    console.log(JSON.stringify({prepared, request: requests[1]}));
                }).catch(() => { process.exitCode = 1; });
        `], { cwd: home, env, encoding: 'utf8', timeout: 10000 });
        expect(library.status).toBe(0);
        expect(JSON.parse(library.stdout)).toMatchObject({
            prepared: { pathArguments: { key: '9223372036854775807' } },
            request: { method: 'GET', url: 'https://operate.invalid/prefix/v1/variables/9223372036854775807',
                headers: { Authorization: 'Bearer dummy-token' } },
        });
        expect(await readFile(path.join(output, 'operate-8.7/operate-openapi.yaml'), 'utf8'))
            .toBe(await readFile(path.resolve(__dirname, '../resources/operate-8.7/operate-openapi.yaml'), 'utf8'));
    } finally {
        await rm(home, { recursive: true, force: true });
    }
}, 45000);
