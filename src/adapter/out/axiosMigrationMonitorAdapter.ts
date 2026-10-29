import axios, { AxiosInstance, AxiosPromise } from 'axios';
import { isLosslessNumber, parse, stringify } from 'lossless-json';
import { MigrationMonitorOutPort } from '../../application/ports/out/migrationMonitorOutPort';
import { OperateConnection } from '../../domain/operateConnection';
import { inconsistentMonitorData, MonitorDefinition, MonitorInstance } from '../../domain/migrationMonitor';
import { dispatchOperateRequest } from './operateApiDispatch';

export class AxiosMigrationMonitorAdapter implements MigrationMonitorOutPort {
    constructor(private readonly http: AxiosInstance = axios.create()) {}

    async discover(connection: OperateConnection): Promise<{ definitions: MonitorDefinition[]; instances: MonitorInstance[] }> {
        const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: connection.clientId, client_secret: connection.clientSecret });
        if (connection.audience !== undefined) form.set('audience', connection.audience);
        const auth = record(await this.request(() => this.http.post(connection.oAuthUrl, form.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000, maxRedirects: 0,
            responseType: 'text', transformResponse: [(value: unknown) => value],
        }), 'OAuth authentication'));
        const token = auth?.access_token;
        if (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) throw new Error('OAuth authentication returned an invalid access_token.');
        const basePath = connection.operateUrl.replace(/\/v1$/, '');
        const definitions = await this.search(basePath, token, 'search_2', {}, (item): MonitorDefinition => {
            if (item.name !== undefined && item.name !== null && typeof item.name !== 'string') throw inconsistentMonitorData();
            return { key: decimalKey(item.key), bpmnProcessId: processId(item.bpmnProcessId), version: numericVersion(item.version),
                name: typeof item.name === 'string' ? item.name : undefined, ...tenant(item) };
        });
        const instances = await this.search(basePath, token, 'search_1', { state: 'ACTIVE' }, (item): MonitorInstance => {
            if (item.state !== 'ACTIVE') throw inconsistentMonitorData();
            return { key: decimalKey(item.key), processDefinitionKey: decimalKey(item.processDefinitionKey),
                bpmnProcessId: processId(item.bpmnProcessId), processVersion: numericVersion(item.processVersion), ...tenant(item) };
        });
        return { definitions, instances };
    }

    private async search<T extends { key: string }>(basePath: string, token: string, operationId: 'search_1' | 'search_2',
        filter: object, decode: (item: Record<string, unknown>) => T): Promise<T[]> {
        const items: T[] = [];
        let searchAfter: unknown[] | undefined;
        let previousKey: bigint | undefined;
        for (;;) {
            const body = stringify({ filter, size: 100, sort: [{ field: 'key', order: 'ASC' }], ...(searchAfter ? { searchAfter } : {}) })!;
            const page = record(await this.request(() => dispatchOperateRequest(this.http, basePath, token, { operationId, body }), 'Operate migration monitor discovery'));
            if (!page || !Array.isArray(page.items)) throw inconsistentMonitorData();
            if (!page.items.length) return items;
            const batch = page.items.map((value) => {
                const item = record(value);
                if (!item) throw inconsistentMonitorData();
                return decode(item);
            });
            for (const item of batch) {
                const key = BigInt(item.key);
                if (previousKey !== undefined && key <= previousKey) throw inconsistentMonitorData();
                previousKey = key;
            }
            const cursor = page.sortValues;
            if (!Array.isArray(cursor) || !cursor.length ||
                !cursor.every((value) => typeof value === 'string' || isLosslessNumber(value) || value === null) ||
                decimalKey(cursor[0]) !== batch[batch.length - 1].key ||
                (searchAfter && stringify(cursor) === stringify(searchAfter))) throw inconsistentMonitorData();
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
            // eslint-disable-next-line preserve-caught-error -- Axios causes expose credentials, request configs, and response data.
            throw new Error(`${operation} failed${status !== undefined || unexpected ? ` (HTTP ${status ?? unexpected})` : ''}. Check profile endpoints, credentials, permissions, and connectivity.`);
        }
        try {
            if (typeof text !== 'string') throw new Error();
            return parse(text);
        } catch { throw new Error(`${operation} returned malformed JSON. Retry the report.`); }
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function decimalKey(value: unknown): string {
    const text = isLosslessNumber(value) ? value.value : value;
    if (typeof text !== 'string' || !/^\d+$/.test(text)) throw inconsistentMonitorData();
    const key = BigInt(text);
    if (key <= 0n || key > 9223372036854775807n) throw inconsistentMonitorData();
    return key.toString();
}
function numericVersion(value: unknown): number {
    if (!isLosslessNumber(value) || !/^\d+$/.test(value.value)) throw inconsistentMonitorData();
    const version = Number(value.value);
    if (!Number.isInteger(version) || version < 1 || version > 2147483647) throw inconsistentMonitorData();
    return version;
}
function processId(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw inconsistentMonitorData();
    return value;
}
function tenant(item: Record<string, unknown>): { tenantId?: string } {
    if (item.tenantId !== undefined && typeof item.tenantId !== 'string') throw inconsistentMonitorData();
    return item.tenantId === undefined ? {} : { tenantId: item.tenantId as string };
}
