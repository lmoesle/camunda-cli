import { AxiosInstance } from 'axios';
import { AxiosIncidentAdapter, AxiosMigrationAdapter } from '../src';
import { IncidentApi, ProcessDefinitionApi, ProcessInstanceApi } from '../src/adapter/out/generated/operate/api';

const root = 'https://operate.invalid/proxy/cluster';
const oauth = { oAuthUrl: 'https://auth.invalid/token', clientId: 'dummy-client', clientSecret: 'dummy-secret',
    operateAudience: 'operate-audience', audience: 'gateway-audience' };
const key = '9007199254740993';
const definitionKey = '9223372036854775807';
const response = (data: string, status = 200) => ({ data, status, headers: { 'content-type': 'text/plain' } });

describe('legacy workflows dispatch through real generated Operate clients', () => {
    test.each(['', '/v1', '/v1/v1'])('incident search preserves prefix %s and exact opaque cursor', async (suffix) => {
        const spy = jest.spyOn(IncidentApi.prototype, 'search3');
        try {
            const post = jest.fn().mockResolvedValue(response('{"access_token":"operate-token"}'));
            const request = jest.fn().mockResolvedValueOnce(response(`{"items":[{"key":${key},"processInstanceKey":${definitionKey},"state":"ACTIVE","type":"JOB_NO_RETRIES","message":"dummy","creationTime":"now"}],"sortValues":[${key},null,"tie"]}`))
                .mockResolvedValueOnce(response('{"items":[]}'));
            const adapter = new AxiosIncidentAdapter({ post, request } as unknown as AxiosInstance);
            const result = await adapter.searchActiveIncidents({ ...oauth, operateUrl: root + suffix });
            expect(result[0]).toMatchObject({ key, processInstanceKey: definitionKey });
            expect(post).toHaveBeenCalledTimes(1);
            expect(post.mock.calls[0][0]).toBe(oauth.oAuthUrl);
            expect(spy).toHaveBeenCalledTimes(2);
            expect(spy.mock.calls[0][0]).toEqual({ queryIncident: '{"filter":{"state":"ACTIVE"},"size":100,"sort":[{"field":"key","order":"ASC"}]}' });
            expect(request.mock.calls[1][0]).toMatchObject({
                method: 'POST', url: `${root}${suffix === '/v1/v1' ? '/v1' : ''}/v1/incidents/search`,
                data: `{"filter":{"state":"ACTIVE"},"size":100,"sort":[{"field":"key","order":"ASC"}],"searchAfter":[${key},null,"tie"]}`,
                headers: { Authorization: 'Bearer operate-token', 'Content-Type': 'application/json' },
                timeout: 30000, maxRedirects: 0, responseType: 'text',
            });
            expect(request.mock.calls[0][0].transformResponse[0]('9007199254740993')).toBe('9007199254740993');
        } finally { spy.mockRestore(); }
    });

    test.each([false, true].flatMap((authenticated) => ['', '/v1', '/v1/v1'].map((suffix) => ({ authenticated, suffix }))))(
        'migration discovery uses both generated searches (auth=$authenticated, suffix=$suffix)', async ({ authenticated, suffix }) => {
            const definitions = jest.spyOn(ProcessDefinitionApi.prototype, 'search2');
            const instances = jest.spyOn(ProcessInstanceApi.prototype, 'search1');
            try {
                const post = jest.fn().mockResolvedValueOnce(response('{"access_token":"operate-token"}'))
                    .mockResolvedValueOnce(response('{"access_token":"gateway-token"}'))
                    .mockResolvedValueOnce(response('', 204));
                const request = jest.fn()
                    .mockResolvedValueOnce(response(`{"items":[{"key":${definitionKey},"bpmnProcessId":"process","version":1}],"sortValues":[${definitionKey},null,"tie"]}`))
                    .mockResolvedValueOnce(response('{"items":[]}'))
                    .mockResolvedValueOnce(response(`{"items":[{"key":${key},"processDefinitionKey":${definitionKey},"state":"ACTIVE"}],"sortValues":[${key},null,"tie"]}`))
                    .mockResolvedValueOnce(response('{"items":[]}'));
                const session = await new AxiosMigrationAdapter({ post, request } as unknown as AxiosInstance).connect({
                    operateUrl: root + suffix, gatewayUrl: 'https://gateway.invalid/v2', ...(authenticated ? { oauth } : {}),
                });
                const found = await session.searchDefinitions('process', 1);
                expect(found).toEqual([{ key: definitionKey, bpmnProcessId: 'process', version: 1 }]);
                expect(await session.searchActiveInstances(found[0])).toEqual([{ key, processDefinitionKey: definitionKey, state: 'ACTIVE' }]);
                expect(definitions).toHaveBeenCalledTimes(2);
                expect(instances).toHaveBeenCalledTimes(2);
                const definitionBody = '{"filter":{"bpmnProcessId":"process","version":1},"size":100,"sort":[{"field":"key","order":"ASC"}]}';
                const instanceBody = `{"filter":{"processDefinitionKey":${definitionKey},"state":"ACTIVE"},"size":100,"sort":[{"field":"key","order":"ASC"}]}`;
                expect(definitions.mock.calls[0][0]).toEqual({ queryProcessDefinition: definitionBody });
                expect(instances.mock.calls[0][0]).toEqual({ queryProcessInstance: instanceBody });
                for (const [index, endpoint, body] of [[0, 'process-definitions', definitionBody], [2, 'process-instances', instanceBody]] as const) {
                    expect(request.mock.calls[index][0]).toMatchObject({ method: 'POST',
                        url: `${root}${suffix === '/v1/v1' ? '/v1' : ''}/v1/${endpoint}/search`, data: body,
                        timeout: 30000, maxRedirects: 0, responseType: 'text',
                    });
                    expect(request.mock.calls[index][0].headers.Authorization).toBe(authenticated ? 'Bearer operate-token' : undefined);
                }
                expect(request.mock.calls[1][0].data).toContain(`"searchAfter":[${definitionKey},null,"tie"]`);
                expect(request.mock.calls[3][0].data).toContain(`"searchAfter":[${key},null,"tie"]`);
                expect(post).toHaveBeenCalledTimes(authenticated ? 2 : 0);
                if (authenticated) {
                    expect(new URLSearchParams(post.mock.calls[0][1]).get('audience')).toBe('operate-audience');
                    expect(new URLSearchParams(post.mock.calls[1][1]).get('audience')).toBe('gateway-audience');
                    await session.migrate(key, definitionKey, []);
                    expect(post.mock.calls[2][0]).toBe(`https://gateway.invalid/v2/process-instances/${key}/migration`);
                    expect(post.mock.calls[2][2].headers.Authorization).toBe('Bearer gateway-token');
                }
            } finally { definitions.mockRestore(); instances.mockRestore(); }
        },
    );

    test.each([201, 202, 204, 206])('migration discovery still requires HTTP 200, rejecting %i safely', async (status) => {
        const request = jest.fn().mockResolvedValue(response('{"items":[],"secret":"dummy-secret"}', status));
        const session = await new AxiosMigrationAdapter({ request } as unknown as AxiosInstance).connect({
            operateUrl: root, gatewayUrl: 'https://gateway.invalid/v2',
        });
        const failure = session.searchDefinitions('process', 1);
        await expect(failure).rejects.toThrow(`Operate migration discovery failed (HTTP ${status}).`);
        await expect(failure).rejects.not.toThrow('dummy-secret');
        await expect(failure).rejects.not.toHaveProperty('cause');
    });
});
