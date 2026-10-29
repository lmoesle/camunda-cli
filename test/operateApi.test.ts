import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { isLosslessNumber, parse, stringify } from 'lossless-json';
import { parse as parseYaml } from 'yaml';
import {
    AxiosOperateApiAdapter, ConsoleApiResultPresenter, createCamundaCli, createDefaultCamundaCli,
    listOperateOperations, operateConnection, operateMetadata, OperateApiUseCase, prepareOperateRequest, Profile, runDefaultCamundaCli,
} from '../src';
import { ApiSchema, OperateRequest } from '../src/domain/operateApiTypes';
import * as generated from '../src/adapter/out/generated/operate/api';
import { dispatchOperateRequest } from '../src/adapter/out/operateApiDispatch';

const profile: Profile = {
    name: 'dummy', baseUrl: 'https://unused.invalid', operateUrl: 'https://operate.invalid/prefix/',
    oAuthUrl: 'https://oauth.invalid/token', clientId: 'dummy-id', clientSecret: 'dummy-secret', audience: 'dummy-audience',
};

function fixture() {
    const profiles = { getProfile: jest.fn().mockReturnValue(profile) };
    const api = { execute: jest.fn().mockResolvedValue(null) };
    const presenter = { showApiResult: jest.fn() };
    return { profiles, api, presenter, usecase: new OperateApiUseCase(profiles, api, presenter, operateMetadata) };
}

describe('pinned official Operate registry', () => {
    test('exposes only the reviewed reads while preserving the complete upstream spec', () => {
        const source = readFileSync(path.resolve(__dirname, '../resources/operate-8.7/operate-openapi.yaml'), 'utf8');
        expect(createHash('sha256').update(source).digest('hex')).toBe('0f1cfa4a3dfcaaa551f8ceb899b41af57d6c799723dbc4b5e632883742df14df');
        const spec = parseYaml(source);
        const expected = Object.entries(spec.paths).flatMap(([url, item]) =>
            Object.entries(item as Record<string, { operationId: string }>).map(([method, op]) => ({
                operationId: op.operationId, method: method.toUpperCase(), path: url,
            })));
        expect(listOperateOperations().map(({ operationId, method, path }) => ({ operationId, method, path })))
            .toEqual(expected.filter((operation) => operation.operationId !== 'delete'));
        expect(listOperateOperations().filter((operation) => operation.method === 'GET')).toHaveLength(12);
        expect(listOperateOperations().filter((operation) => operation.method === 'POST')).toHaveLength(8);
        expect(expected).toHaveLength(21);
        expect(new Set(expected.map((operation) => operation.operationId)).size).toBe(expected.length);
    });

    test('all spec constraints and serialization styles are supported by the lossless validator', () => {
        const keywords = ['$ref', 'type', 'format', 'properties', 'items', 'enum', 'description', 'required', 'additionalProperties'];
        function check(schema: ApiSchema) {
            expect(Object.keys(schema).every((key) => keywords.includes(key))).toBe(true);
            if (schema.type) expect(['object', 'array', 'string', 'boolean', 'integer']).toContain(schema.type);
            if (schema.format) expect(['int32', 'int64']).toContain(schema.format);
            if (schema.$ref) {
                expect(schema.$ref.startsWith('#/components/schemas/')).toBe(true);
                expect(operateMetadata.schemas).toHaveProperty(schema.$ref.slice('#/components/schemas/'.length));
            }
            Object.values(schema.properties ?? {}).forEach(check);
            if (schema.items) check(schema.items);
            if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(schema.additionalProperties);
        }
        Object.values(operateMetadata.schemas).forEach(check);
        for (const operation of listOperateOperations()) {
            for (const parameter of operation.parameters) {
                expect(['path', 'query']).toContain(parameter.in);
                expect(['integer', 'boolean', 'string']).toContain(parameter.schema.type);
                expect(parameter).not.toHaveProperty('style');
                expect(parameter).not.toHaveProperty('explode');
                check(parameter.schema);
            }
            if (operation.requestBody) {
                expect(Object.keys(operation.requestBody.content)).toEqual(['application/json']);
                check(operation.requestBody.content['application/json'].schema);
            }
        }
    });

    test('lists only reads offline without accessing profiles or transport, including XML', async () => {
        const { usecase, profiles, api, presenter } = fixture();
        await usecase.invokeApi({ usecase: 'ls' });
        expect(profiles.getProfile).not.toHaveBeenCalled();
        expect(api.execute).not.toHaveBeenCalled();
        expect(presenter.showApiResult).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({ operationId: 'xmlByKey', path: '/v1/process-definitions/{key}/xml' }),
        ]));
        expect(presenter.showApiResult.mock.calls[0][0]).toHaveLength(20);
        expect(presenter.showApiResult.mock.calls[0][0]).not.toContainEqual(expect.objectContaining({ operationId: 'delete' }));
    });
});

describe('API validation and application dispatch', () => {
    test.each([
        ['byKey_1', '{"path":{"key":{"isLosslessNumber":true,"value":"9"}}}'],
        ['search', '{"body":{"filter":{"key":{"isLosslessNumber":true,"value":"9"}}}}'],
    ])('rejects spoofed integer objects for %s before profile lookup or transport', async (operation, requestJson) => {
        const { usecase, profiles, api } = fixture();
        await expect(usecase.invokeApi({ usecase: operation, requestJson, profile: 'dummy' })).rejects.toThrow('Invalid API request');
        expect(profiles.getProfile).not.toHaveBeenCalled();
        expect(api.execute).not.toHaveBeenCalled();
    });

    test.each([
        '{"extension":{"isLosslessNumber":true,"value":"10"},"keys":[9007199254740993,{"isLosslessNumber":true,"value":"11"}]}',
        '{"isLosslessNumber":true,"value":"9","extension":{"isLosslessNumber":true,"value":"10"},"keys":[9007199254740993,{"isLosslessNumber":true,"value":"11"}]}',
    ])('preserves marker-colliding objects in permitted additional body properties and genuine huge integers: %s', (body) => {
        const prepared = prepareOperateRequest('search', `{"body":${body}}`);
        expect(prepared.body).toBe(body);
        expect(JSON.parse(prepared.body!)).toMatchObject({ extension: { isLosslessNumber: true, value: '10' } });
    });

    test.each([
        ['not-an-operation', '{}'], ['byKey', 'not json dummy-secret'], ['byKey', '[]'], ['byKey', 'null'],
        ['byKey', '{}'], ['byKey', '{"path":null}'], ['byKey', '{"path":[]}'],
        ['byKey', '{"path":{"key":"9007199254740993"}}'], ['byKey', '{"path":{"key":1.2}}'],
        ['byKey', '{"path":{"key":9223372036854775808}}'], ['byKey', '{"path":{"key":-9223372036854775809}}'],
        ['byKey', '{"path":{"key":1,"other":"secret"}}'], ['byKey', '{"path":{"key":1},"query":{"url":"https://evil.invalid"}}'],
        ['byKey', '{"path":{"key":1},"body":{}}'], ['byKey', '{"url":"https://evil.invalid"}'],
        ['byKey', '{"headers":{"Authorization":"secret"}}'], ['search', '{"body":null}'],
        ['search', '{"body":{"size":2147483648}}'], ['search', '{"body":{"size":true}}'],
        ['search', '{"body":{"filter":{"truncated":"true"}}}'], ['search', '{"body":{"filter":{"name":42}}}'],
        ['search', '{"body":{"sort":[{"order":"ascending"}]}}'], ['search', '{"body":{"sort":{}}}'],
        ['search', '{"body":{"sort":[42]}}'], ['search_1', '{"body":{"filter":{"state":"INVALID"}}}'],
        ['search_1', '{"body":{"filter":{"parentProcessInstanceKey":{"key":false}}}}'],
        ['byId', '{"path":{"id":".."}}'], ['byId', '{"path":{"id":""}}'],
    ])('%s rejects invalid request %s before profile lookup or OAuth/network', async (usecase, requestJson) => {
        const fixtureValue = fixture();
        await expect(fixtureValue.usecase.invokeApi({ usecase, requestJson, profile: 'dummy' })).rejects.toThrow(/Invalid API request|Unknown or unsupported Operate API/);
        expect(fixtureValue.profiles.getProfile).not.toHaveBeenCalled();
        expect(fixtureValue.api.execute).not.toHaveBeenCalled();
    });

    test('validates referenced schemas and preserves exact int64 bodies and paths', async () => {
        const { usecase, api } = fixture();
        await usecase.invokeApi({ usecase: 'search_3', requestJson: '{"body":{"filter":{"key":9007199254740993,"state":"ACTIVE"},"sort":[{"order":"ASC"}]}}', profile: 'dummy' });
        expect(api.execute.mock.calls[0][1].body).toContain('9007199254740993');
        expect(prepareOperateRequest('byKey', '{"path":{"key":9223372036854775807}}').path).toBe('/v1/variables/9223372036854775807');
        expect(prepareOperateRequest('byKey', '{"path":{"key":-9223372036854775808}}').path).toBe('/v1/variables/-9223372036854775808');
        expect(prepareOperateRequest('byKey', '{"path":{"key":1.00e2}}').path).toBe('/v1/variables/100');
        expect(prepareOperateRequest('byKey', '{"path":{"key":1000e-3}}').path).toBe('/v1/variables/1');
        expect(prepareOperateRequest('byKey', '{"path":{"key":0e99999}}').path).toBe('/v1/variables/0');
    });

    test('optional bodies stay absent and additional body properties follow OpenAPI defaults', () => {
        expect(prepareOperateRequest('search', '{}')).not.toHaveProperty('body');
        expect(prepareOperateRequest('search', '{"body":{"extension":9007199254740993}}').body).toBe('{"extension":9007199254740993}');
    });

    test('encodes string path values as one segment without allowing origin overrides', () => {
        expect(prepareOperateRequest('byId', '{"path":{"id":"a/b ?#%雪"}}').path)
            .toBe('/v1/decision-instances/a%2Fb%20%3F%23%25%E9%9B%AA');
    });

    test.each(['{"path":{"key":9}}', 'not JSON dummy-secret', undefined])('rejects delete before parsing, profiles, or transport: %s', async (requestJson) => {
        const { usecase, profiles, api, presenter } = fixture();
        const failure = usecase.invokeApi({ usecase: 'delete', requestJson });
        await expect(failure).rejects.toThrow('read-only');
        await expect(failure).rejects.toThrow('https://github.com/lmoesle/camunda-cli/issues/new');
        await expect(failure).rejects.not.toThrow('dummy-secret');
        expect(profiles.getProfile).not.toHaveBeenCalled();
        expect(api.execute).not.toHaveBeenCalled();
        expect(presenter.showApiResult).not.toHaveBeenCalled();
    });

    test.each([
        { operationId: 'futureRead', method: 'GET', path: '/v1/future' },
        { operationId: 'futureSearch', method: 'POST', path: '/v1/future/search' },
        { operationId: 'search', method: 'DELETE', path: '/v1/variables/search' },
        { operationId: 'search', method: 'POST', path: '/v1/future/search' },
        { operationId: 'delete', method: 'GET', path: '/v1/process-instances/{key}' },
    ])('fails closed for unreviewed metadata tuples: $operationId $method $path', async (tuple) => {
        const { profiles, api, presenter } = fixture();
        const metadata = { ...operateMetadata, operations: [{ ...tuple, summary: '', parameters: [] }] };
        const usecase = new OperateApiUseCase(profiles, api, presenter, metadata);
        await usecase.invokeApi({ usecase: 'ls' });
        expect(presenter.showApiResult).toHaveBeenCalledWith([]);
        await expect(usecase.invokeApi({ usecase: tuple.operationId, requestJson: 'malformed' })).rejects.toThrow('read-only');
        expect(profiles.getProfile).not.toHaveBeenCalled();
        expect(api.execute).not.toHaveBeenCalled();
    });

    test.each([undefined, '', '  '])('requires a profile for execution: %s', async (selected) => {
        const { usecase, api } = fixture();
        await expect(usecase.invokeApi({ usecase: 'search', requestJson: '{}', profile: selected })).rejects.toThrow('profile');
        expect(api.execute).not.toHaveBeenCalled();
    });

    test('rejects missing profiles without echoing untrusted profile names', async () => {
        const { usecase, profiles, api } = fixture();
        profiles.getProfile.mockReturnValue(undefined);
        await expect(usecase.invokeApi({ usecase: 'search', requestJson: '{}', profile: 'dummy-secret' })).rejects.toThrow('selected profile does not exist');
        expect(api.execute).not.toHaveBeenCalled();
    });
});

describe('OAuth-only Operate profiles', () => {
    test.each(['operateUrl', 'oAuthUrl', 'clientId', 'clientSecret'] as const)('requires %s', (field) => {
        expect(() => operateConnection({ ...profile, [field]: undefined }, 'api')).toThrow(field);
        expect(() => operateConnection({ ...profile, [field]: ' ' }, 'api')).toThrow(field);
    });
    test.each(['https://user:password@operate.invalid', 'https://operate.invalid?secret', 'https://operate.invalid#secret', 'file:///secret'])('rejects unsafe endpoints %s', (operateUrl) => {
        expect(() => operateConnection({ ...profile, operateUrl }, 'api')).toThrow('HTTP(S)');
    });
    test('uses explicit Operate audience, rejects blank override, and falls back like incidents', () => {
        expect(operateConnection({ ...profile, operateAudience: 'operate-only' }, 'api').audience).toBe('operate-only');
        expect(operateConnection(profile, 'api').audience).toBe('dummy-audience');
        expect(operateConnection({ ...profile, audience: undefined }, 'api').audience).toBeUndefined();
        expect(() => operateConnection({ ...profile, operateAudience: '' }, 'api')).toThrow('operateAudience');
        expect(() => operateConnection({ ...profile, operateUrl: 'https://region.operate.camunda.io', audience: undefined }, 'api')).toThrow('audience');
        expect(() => operateConnection({ ...profile, oAuthUrl: 'https://login.cloud.camunda.io/oauth/token', audience: undefined }, 'api')).toThrow('audience');
    });
});

function response(data: unknown, contentType = 'application/json', status = 200): AxiosResponse {
    return { data, status, statusText: '', headers: { 'content-type': contentType }, config: { headers: {} } } as AxiosResponse;
}

describe('safe lossless HTTP transport and presentation', () => {
    const connection = operateConnection(profile, 'api');
    function transport(result = response('{"key":9007199254740993}')) {
        const request = jest.fn().mockResolvedValueOnce(response('{"access_token":"dummy-token"}')).mockResolvedValueOnce(result);
        return { request, adapter: new AxiosOperateApiAdapter({ request } as unknown as AxiosInstance) };
    }

    test.each(['adapter', 'dispatcher'].flatMap((boundary) => ['byId', 'xmlByKey'].flatMap((operationId) =>
        [undefined, '', '.', '..'].flatMap((value) => [false, true].map((includePath) => ({ boundary, operationId, value, includePath }))))))(
        '$boundary rejects missing/unsafe template arguments before OAuth/transport: $operationId value=$value includePath=$includePath',
        async ({ boundary, operationId, value, includePath }) => {
            const { request, adapter } = transport();
            const prepared = prepareOperateRequest(operationId, operationId === 'byId' ? '{"path":{"id":"opaque"}}' : '{"path":{"key":9}}');
            const name = operationId === 'byId' ? 'id' : 'key';
            const template = listOperateOperations().find((operation) => operation.operationId === operationId)!.path;
            // JavaScript library callers can omit transport metadata or required arguments.
            const forged = {
                ...prepared, pathArguments: value === undefined ? {} : { [name]: value },
                path: includePath ? template.replace(`{${name}}`, value ?? '') : undefined,
            } as OperateRequest;
            if (boundary === 'adapter') await expect(adapter.execute(connection, forged)).rejects.toThrow('read-only');
            else await expect(async () => dispatchOperateRequest({ request } as unknown as AxiosInstance, 'https://operate.invalid', undefined, forged))
                .rejects.toThrow('read-only');
            expect(request).not.toHaveBeenCalled();
        },
    );

    test.each([
        { operationId: 'delete', method: 'DELETE', path: '/v1/process-instances/9' },
        { operationId: 'delete', method: 'GET', path: '/v1/process-instances/9' },
        { operationId: 'future', method: 'GET', path: '/v1/future' },
        { operationId: 'futureSearch', method: 'POST', path: '/v1/future/search' },
        { operationId: 'search', method: 'DELETE', path: '/v1/variables/search' },
        { operationId: 'search', method: 'POST', path: '/v1/process-instances/9' },
        { operationId: 'byKey_1', method: 'GET', path: '/v1/process-instances/9/delete' },
    ])('adapter and dispatcher reject forged requests before OAuth/transport: $operationId $method $path', async (tuple) => {
        const { request, adapter } = transport();
        const forged = { ...tuple, pathArguments: { key: '9' }, queryArguments: {}, query: '', body: 'malformed dummy-secret' };
        await expect(adapter.execute(connection, forged)).rejects.toThrow('read-only');
        expect(() => dispatchOperateRequest({ request } as unknown as AxiosInstance, 'https://operate.invalid', 'dummy', forged))
            .toThrow('read-only');
        expect(request).not.toHaveBeenCalled();
    });

    test.each(['delete', 'future', 'toString', '__proto__'])('dispatcher rejects unapproved IDs even without method/path: %s', (operationId) => {
        const request = jest.fn();
        expect(() => dispatchOperateRequest({ request } as unknown as AxiosInstance, 'https://operate.invalid', undefined, { operationId }))
            .toThrow('read-only');
        expect(request).not.toHaveBeenCalled();
    });

    test.each(['a/b ?#%雪', '%2e%2e', '..opaque'])('dispatcher preserves opaque IDs without optional path metadata: %s', async (id) => {
        const request = jest.fn().mockResolvedValue(response('{}'));
        await dispatchOperateRequest({ request } as unknown as AxiosInstance, 'https://operate.invalid', undefined, {
            operationId: 'byId', pathArguments: { id },
        });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'GET', url: `https://operate.invalid/v1/decision-instances/${encodeURIComponent(id)}`,
        }));
    });

    test.each(listOperateOperations())('dispatches $operationId through its real generated method with exact arguments', async (operation) => {
        const method = operation.operationId.replace(/_(\d+)$/, '$1');
        const classes = [generated.VariableApi, generated.ProcessInstanceApi, generated.ProcessDefinitionApi,
            generated.IncidentApi, generated.FlownodeInstanceApi, generated.DecisionRequirementsApi,
            generated.DecisionInstanceApi, generated.DecisionDefinitionApi];
        const owners = classes.filter((client) => Object.prototype.hasOwnProperty.call(client.prototype, method));
        expect(owners).toHaveLength(1);
        const prototype = owners[0].prototype as unknown as Record<string, (args: Record<string, unknown>) => unknown>;
        const spy = jest.spyOn(prototype, method);
        try {
            const pathInput = operation.parameters.some((parameter) => parameter.name === 'id')
                ? '{"id":"a/b ?#%雪"}' : operation.parameters.length ? '{"key":9223372036854775807}' : '{}';
            const bodies = operation.requestBody ? [undefined,
                '{"extension":{"isLosslessNumber":true,"value":"9"},"keys":[9007199254740993,{"isLosslessNumber":true,"value":"11"}]}'] : [undefined];
            for (const body of bodies) {
                const prepared = prepareOperateRequest(operation.operationId, `{"path":${pathInput}${body ? `,"body":${body}` : ''}}`);
                const { request, adapter } = transport();
                await adapter.execute(connection, prepared);
                expect(spy).toHaveBeenCalled();
                expect(request.mock.calls[1][0]).toMatchObject({
                    method: operation.method, url: `https://operate.invalid/prefix${prepared.path}`,
                    data: body, timeout: 30000, maxRedirects: 0, responseType: 'text',
                    headers: { Authorization: 'Bearer dummy-token' },
                });
                const args = spy.mock.calls[spy.mock.calls.length - 1][0];
                if (operation.parameters.length) expect(args).toEqual(prepared.pathArguments);
                if (body) expect(Object.values(args)).toContain(body);
            }
        } finally { spy.mockRestore(); }
    });

    test('preserves response objects whose properties collide with lossless-number markers', async () => {
        const { adapter } = transport(response('{"isLosslessNumber":true,"value":"9","nested":[{"isLosslessNumber":true,"value":"10"}],"key":9007199254740993}'));
        const output = jest.fn();
        new ConsoleApiResultPresenter(output).showApiResult(await adapter.execute(connection, prepareOperateRequest('search', '{}')));
        expect(output).toHaveBeenCalledWith('{\n  "isLosslessNumber": true,\n  "value": "9",\n  "nested": [\n    {\n      "isLosslessNumber": true,\n      "value": "10"\n    }\n  ],\n  "key": 9007199254740993\n}');
        expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ isLosslessNumber: true, value: '9', nested: [{ isLosslessNumber: true, value: '10' }] });
    });

    test.each(['https://operate.invalid/prefix', 'https://operate.invalid/prefix/v1'])('preserves URL prefix from %s, authenticates and serializes the exact body', async (operateUrl) => {
        const { request, adapter } = transport();
        const result = await adapter.execute({ ...connection, operateUrl }, prepareOperateRequest('search', '{"body":{"filter":{"key":9007199254740993}}}'));
        expect(request.mock.calls[0][0]).toMatchObject({ method: 'POST', url: 'https://oauth.invalid/token', timeout: 30000, maxRedirects: 0 });
        expect(new URLSearchParams(request.mock.calls[0][0].data).get('audience')).toBe('dummy-audience');
        expect(request.mock.calls[1][0]).toMatchObject({
            method: 'POST', url: 'https://operate.invalid/prefix/v1/variables/search',
            data: '{"filter":{"key":9007199254740993}}', headers: { Authorization: 'Bearer dummy-token', 'Content-Type': 'application/json' },
            timeout: 30000, maxRedirects: 0, responseType: 'text',
        });
        const output = jest.fn();
        new ConsoleApiResultPresenter(output).showApiResult(result);
        expect(output).toHaveBeenCalledWith('{\n  "key": 9007199254740993\n}');
        expect(isLosslessNumber((parse(output.mock.calls[0][0]) as Record<string, unknown>).key)).toBe(true);
    });

    test('transports encoded path arguments using the generated client', async () => {
        const { request, adapter } = transport();
        await adapter.execute(connection, prepareOperateRequest('byId', '{"path":{"id":"a/b ?#%雪"}}'));
        expect(request.mock.calls[1][0]).toMatchObject({ url: 'https://operate.invalid/prefix/v1/decision-instances/a%2Fb%20%3F%23%25%E9%9B%AA' });
    });

    test.each([
        [response('[9007199254740993]', 'application/json; charset=UTF-8'), '[9007199254740993]'],
        [response('{"ok":true}', 'application/problem+json'), '{"ok":true}'],
        [response('"hello"'), '"hello"'], [response('true'), 'true'], [response('null'), 'null'],
        [response('<xml>"value"\n</xml>', 'application/xml'), '"<xml>\\"value\\"\\n</xml>"'],
        [response('plain text', 'text/plain'), '"plain text"'], [response('', 'application/json', 204), 'null'],
        [response('', 'text/plain'), 'null'],
        [response(undefined), 'null'], [response(null), 'null'], [response('', 'application/json', 205), 'null'],
    ])('handles response forms %#', async (result, expected) => {
        const { adapter } = transport(result);
        expect(stringify(await adapter.execute(connection, prepareOperateRequest('byKey', '{"path":{"key":1}}')))).toBe(expected);
    });

    test('rejects malformed JSON without leaking response body', async () => {
        const { adapter } = transport(response('dummy-secret'));
        await expect(adapter.execute(connection, prepareOperateRequest('search', '{}'))).rejects.toThrow('Operate API request returned malformed JSON.');
    });

    test.each(['oauth', 'operate'])('sanitizes %s HTTP errors and drops unsafe causes', async (phase) => {
        const request = jest.fn();
        if (phase === 'operate') request.mockResolvedValueOnce(response('{"access_token":"dummy-token"}'));
        request.mockRejectedValueOnce(new axios.AxiosError('dummy-secret', 'ERR_BAD_REQUEST', undefined, undefined, response('dummy-secret', 'text/plain', 403)));
        const adapter = new AxiosOperateApiAdapter({ request } as unknown as AxiosInstance);
        try {
            await adapter.execute(connection, prepareOperateRequest('search', '{}'));
            throw new Error('Expected transport failure');
        } catch (error) {
            expect((error as Error).message).toMatch(/failed \(HTTP 403\)/);
            expect((error as Error).message).not.toContain('dummy-secret');
            expect(error).not.toHaveProperty('cause');
        }
        expect(request).toHaveBeenCalledTimes(phase === 'oauth' ? 1 : 2);
    });

    test.each(['{}', '{"access_token":"bad\\nheader"}', 'dummy-secret'])('rejects malformed authentication %s before Operate', async (auth) => {
        const request = jest.fn().mockResolvedValue(response(auth));
        const adapter = new AxiosOperateApiAdapter({ request } as unknown as AxiosInstance);
        await expect(adapter.execute(connection, prepareOperateRequest('search', '{}'))).rejects.toThrow(/OAuth authentication/);
        expect(request).toHaveBeenCalledTimes(1);
    });
});

describe('api CLI integration', () => {
    let home: string;
    beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'cli-api-')); });
    afterEach(async () => { await rm(home, { recursive: true, force: true }); });

    test('dispatches api ls and documents request shape and read-only behavior in help', async () => {
        const invokeApi = jest.fn();
        const program = createCamundaCli({ operateApiInPort: { invokeApi } });
        await program.parseAsync(['api', 'ls'], { from: 'user' });
        expect(invokeApi).toHaveBeenCalledWith({ usecase: 'ls', requestJson: undefined });
        const command = program.commands.find((entry) => entry.name() === 'api')!;
        const writeOut = jest.fn();
        command.exitOverride().configureOutput({ writeOut });
        await expect(program.parseAsync(['api', '--help'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
        expect(writeOut.mock.calls.flat().join('')).toMatch(/path.*query.*body/s);
        expect(writeOut.mock.calls.flat().join('')).toContain('Only read-only requests');
        expect(writeOut.mock.calls.flat().join('')).toContain('https://github.com/lmoesle/camunda-cli/issues/new');
    });

    test('default runtime and executable bootstrap keep startup notices off JSON stdout', async () => {
        for (const mode of ['program', 'executable']) {
            const writeLine = jest.fn(); const writeDiagnostic = jest.fn();
            const options = { homeDirectory: home, writeLine, writeDiagnostic };
            if (mode === 'program') await createDefaultCamundaCli(options).parseAsync(['api', 'ls'], { from: 'user' });
            else await runDefaultCamundaCli(['node', 'camunda-cli', 'api', 'ls'], options);
            expect(writeLine).toHaveBeenCalledTimes(1);
            expect(JSON.parse(writeLine.mock.calls[0][0])).toHaveLength(20);
            expect(writeDiagnostic).toHaveBeenCalledTimes(1);
        }
    });

    test('real source executable prints one JSON document on stdout with an empty isolated home', () => {
        const script = `
            const fs = require('node:fs');
            const ts = require(${JSON.stringify(require.resolve('typescript'))});
            require.extensions['.yaml'] = (module, filename) => { module.exports = fs.readFileSync(filename, 'utf8'); };
            require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(
                fs.readFileSync(filename, 'utf8'), { compilerOptions: {
                    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
                } }
            ).outputText, filename);
            process.argv = ['node', 'camunda-cli', 'api', 'ls'];
            require(${JSON.stringify(path.resolve(__dirname, '../src/bin/camunda-cli.ts'))});
        `;
        const child = spawnSync(process.execPath, ['-e', script], {
            env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 10000,
        });
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(JSON.parse(child.stdout)).toHaveLength(20);
        expect(child.stderr).toMatch(/profile/i);
    });
});
