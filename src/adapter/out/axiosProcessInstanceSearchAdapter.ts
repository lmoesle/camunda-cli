import axios, { AxiosInstance, AxiosPromise } from 'axios';
import { LosslessNumber, parse, stringify } from 'lossless-json';
import { ProcessInstanceSearchOutPort } from '../../application/ports/out/processInstanceSearchOutPort';
import { OperateConnection } from '../../domain/operateConnection';
import { ProcessInstanceQuery, ProcessInstanceVariable, QueriedProcessInstance } from '../../domain/processInstanceQuery';
import { dispatchOperateRequest } from './operateApiDispatch';
import { anonymousHttp } from './anonymousHttp';

export class AxiosProcessInstanceSearchAdapter implements ProcessInstanceSearchOutPort {
    constructor(private readonly http: AxiosInstance = axios.create()) {}

    async searchActiveProcessInstances(connection: OperateConnection, query: ProcessInstanceQuery): Promise<QueriedProcessInstance[]> {
        const http = connection.noAuth === true ? anonymousHttp(this.http) : this.http;
        let token: string | undefined;
        if (connection.noAuth !== true) {
            const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: connection.clientId, client_secret: connection.clientSecret });
            if (connection.audience !== undefined) form.set('audience', connection.audience);
            const auth = record(await this.request(() => this.http.post(connection.oAuthUrl, form.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000, maxRedirects: 0,
                responseType: 'text', transformResponse: [(value: unknown) => value],
            }), 'OAuth authentication'));
            if (typeof auth.access_token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(auth.access_token)) {
                throw new Error('OAuth authentication returned an invalid access_token.');
            }
            token = auth.access_token;
        }
        const basePath = connection.operateUrl.replace(/\/v1$/, '');
        const instances = await this.search(http, basePath, token, 'search_1',
            { state: 'ACTIVE', ...(query.key ? { key: new LosslessNumber(query.key) } : {}) }, (item) => {
                const instance = decodeInstance(item);
                if (query.key !== undefined && instance.key !== query.key) throw inconsistent();
                return instance;
            });
        if (query.includeVariables) {
            for (const instance of instances) {
                const variables = await this.search(http, basePath, token, 'search',
                    { processInstanceKey: new LosslessNumber(instance.key) }, (item) => decodeVariable(item, instance));
                for (const variable of variables) {
                    if (!variable.truncated) continue;
                    const detail = decodeVariable(record(await this.request(() => dispatchOperateRequest(http, basePath, token,
                        { operationId: 'byKey', pathArguments: { key: variable.key } }), 'Operate variable detail')), instance);
                    if (detail.truncated || detail.key !== variable.key || detail.processInstanceKey !== variable.processInstanceKey ||
                        detail.scopeKey !== variable.scopeKey || detail.name !== variable.name ||
                        (detail.tenantId !== undefined && variable.tenantId !== undefined && detail.tenantId !== variable.tenantId)) {
                        throw inconsistent();
                    }
                    Object.assign(variable, detail);
                }
                instance.variables = variables.map((variable) => {
                    if (variable.truncated) throw inconsistent();
                    return { ...variable, truncated: false };
                });
            }
        }
        return instances;
    }

    private async search<T extends { key: string }>(http: AxiosInstance, basePath: string, token: string | undefined,
        operationId: 'search_1' | 'search', filter: object, decode: (item: Record<string, unknown>) => T): Promise<T[]> {
        const items: T[] = [];
        let searchAfter: unknown[] | undefined;
        let previousKey: bigint | undefined;
        for (;;) {
            const body = stringify({ filter, size: 100, sort: [{ field: 'key', order: 'ASC' }], ...(searchAfter ? { searchAfter } : {}) })!;
            const page = record(await this.request(() => dispatchOperateRequest(http, basePath, token, { operationId, body }),
                'Operate process instance query'));
            if (!Array.isArray(page.items)) throw inconsistent();
            if (!page.items.length) return items;
            const batch = page.items.map((value) => decode(record(value)));
            for (const item of batch) {
                const key = BigInt(item.key);
                if (previousKey !== undefined && key <= previousKey) throw inconsistent();
                previousKey = key;
            }
            const cursor = page.sortValues;
            if (!Array.isArray(cursor) || !cursor.length ||
                !cursor.every((value) => typeof value === 'string' || value instanceof LosslessNumber || value === null) ||
                decimalKey(cursor[0]) !== batch[batch.length - 1].key ||
                (searchAfter && stringify(cursor) === stringify(searchAfter))) throw inconsistent();
            searchAfter = cursor;
            items.push(...batch);
        }
    }

    private async request(send: () => AxiosPromise<unknown>, operation: string): Promise<unknown> {
        let text: unknown;
        try {
            const response = await send();
            if (response.status !== 200) throw new Error(`${operation} failed (HTTP ${response.status}).`);
            text = response.data;
        } catch (error) {
            const response = axios.isAxiosError(error) ? error.response : undefined;
            const status = typeof response?.status === 'number' && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
                ? response.status : undefined;
            const unexpected = error instanceof Error ? error.message.match(/^.+ failed \(HTTP (\d{3})\)\.$/)?.[1] : undefined;
            // eslint-disable-next-line preserve-caught-error -- Axios causes contain secrets and response bodies.
            throw new Error(`${operation} failed${status !== undefined || unexpected ? ` (HTTP ${status ?? unexpected})` : ''}. Check profile endpoints, credentials, permissions, and connectivity.`);
        }
        try {
            if (typeof text !== 'string') throw new Error();
            return parse(text);
        } catch { throw new Error(`${operation} returned malformed JSON. Retry the query.`); }
    }
}

function inconsistent(): Error {
    return new Error('Operate returned inconsistent or incomplete process instance query data. Retry the query.');
}
function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw inconsistent();
    return value as Record<string, unknown>;
}
function decimalKey(value: unknown): string {
    const text = value instanceof LosslessNumber ? value.value : value;
    if (typeof text !== 'string' || !/^\d+$/.test(text)) throw inconsistent();
    const key = BigInt(text);
    if (key <= 0n || key > 9223372036854775807n) throw inconsistent();
    return key.toString();
}
function text(value: unknown): string {
    if (typeof value !== 'string') throw inconsistent();
    return value;
}
function tenant(item: Record<string, unknown>): { tenantId?: string } {
    return item.tenantId === undefined ? {} : { tenantId: text(item.tenantId) };
}
function decodeInstance(item: Record<string, unknown>): QueriedProcessInstance {
    if (item.state !== 'ACTIVE' || typeof item.incident !== 'boolean') throw inconsistent();
    const bpmnProcessId = text(item.bpmnProcessId);
    const startDate = text(item.startDate);
    if (!bpmnProcessId.trim() || !startDate.trim() || !Number.isFinite(Date.parse(startDate))) throw inconsistent();
    const version = item.processVersion;
    if (!(version instanceof LosslessNumber) || !/^\d+$/.test(version.value) ||
        Number(version.value) < 1 || Number(version.value) > 2147483647) throw inconsistent();
    const instance: QueriedProcessInstance = {
        key: decimalKey(item.key), bpmnProcessId, processVersion: Number(version.value),
        state: 'ACTIVE', incident: item.incident, startDate, ...tenant(item), variables: [],
    };
    if (item.processDefinitionKey !== undefined) instance.processDefinitionKey = decimalKey(item.processDefinitionKey);
    for (const field of ['parentKey', 'parentFlowNodeInstanceKey'] as const) {
        const value = item[field];
        if (value !== undefined) {
            const root = value === '-1' || (value instanceof LosslessNumber && value.value === '-1');
            instance[field] = value === null ? null : root ? '-1' : decimalKey(value);
        }
    }
    if (item.processVersionTag !== undefined) instance.processVersionTag = text(item.processVersionTag);
    if (item.endDate !== undefined) instance.endDate = item.endDate === null ? null : text(item.endDate);
    return instance;
}
function decodeVariable(item: Record<string, unknown>, instance: QueriedProcessInstance): Omit<ProcessInstanceVariable, 'truncated'> & { truncated: boolean } {
    if (typeof item.truncated !== 'boolean') throw inconsistent();
    const variable = {
        key: decimalKey(item.key), processInstanceKey: decimalKey(item.processInstanceKey), scopeKey: decimalKey(item.scopeKey),
        name: text(item.name), value: text(item.value), truncated: item.truncated, ...tenant(item),
    };
    if (!variable.name || variable.processInstanceKey !== instance.key ||
        (variable.tenantId !== undefined && instance.tenantId !== undefined && variable.tenantId !== instance.tenantId)) throw inconsistent();
    return variable;
}
