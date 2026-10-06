import axios, { AxiosInstance } from 'axios';
import { isLosslessNumber, LosslessNumber, parse, stringify } from 'lossless-json';
import { MigrationOutPort, MigrationSession } from '../../application/ports/out/migrationOutPort';
import { MigrationConnection, MigrationDefinition, MigrationInstance, MigrationPlanEntry, MissingMigrationElement } from '../../domain/migration';

interface MigrationRequest {
    instanceKey: string;
    mappingInstructions: MigrationPlanEntry['mappingInstructions'];
}

export class AxiosMigrationAdapter implements MigrationOutPort {
    constructor(private readonly http: AxiosInstance = axios.create()) {}

    async connect(connection: MigrationConnection): Promise<MigrationSession> {
        const token = async (audience: string | undefined): Promise<Record<string, string>> => {
            if (!connection.oauth) return {};
            const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: connection.oauth.clientId,
                client_secret: connection.oauth.clientSecret });
            if (audience !== undefined) form.set('audience', audience);
            const response = record(await this.request(connection.oauth.oAuthUrl, form.toString(),
                { 'Content-Type': 'application/x-www-form-urlencoded' }, 'OAuth authentication'));
            const accessToken = response?.access_token;
            if (typeof accessToken !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(accessToken)) {
                throw new Error('OAuth authentication returned an invalid access_token.');
            }
            return { Authorization: `Bearer ${accessToken}` };
        };
        const operateHeaders = { 'Content-Type': 'application/json', ...await token(connection.oauth?.operateAudience) };
        const gatewayHeaders = { 'Content-Type': 'application/json', ...await token(connection.oauth?.audience) };
        return {
            searchDefinitions: async (bpmnProcessId, version) => this.search(
                `${connection.operateUrl}/process-definitions/search`, { bpmnProcessId, version }, operateHeaders,
                (value): MigrationDefinition => {
                    const item = record(value);
                    if (!item || item.bpmnProcessId !== bpmnProcessId || numericVersion(item.version) !== version) throw malformed();
                    return { key: decimalKey(item.key), bpmnProcessId, version, ...tenant(item) };
                }),
            searchActiveInstances: async (source) => this.search(
                `${connection.operateUrl}/process-instances/search`, { processDefinitionKey: new LosslessNumber(decimalKey(source.key)), state: 'ACTIVE' },
                operateHeaders, (value): MigrationInstance => {
                    const item = record(value);
                    if (!item || item.state !== 'ACTIVE' || decimalKey(item.processDefinitionKey) !== source.key || item.tenantId !== source.tenantId) throw malformed();
                    return { key: decimalKey(item.key), processDefinitionKey: source.key, state: 'ACTIVE', ...tenant(item) };
                }),
            migrate: async (instanceKey, targetProcessDefinitionKey, mappingInstructions) => {
                await this.request(`${connection.gatewayUrl}/process-instances/${decimalKey(instanceKey)}/migration`,
                    JSON.stringify({ targetProcessDefinitionKey: decimalKey(targetProcessDefinitionKey), mappingInstructions }),
                    gatewayHeaders, 'Process instance migration', { instanceKey: decimalKey(instanceKey), mappingInstructions });
            },
        };
    }

    private async search<T extends { key: string }>(url: string, filter: object, headers: Record<string, string>,
        decode: (value: unknown) => T): Promise<T[]> {
        const items: T[] = [];
        let searchAfter: unknown[] | undefined;
        let previousKey: bigint | undefined;
        for (;;) {
            const page = record(await this.request(url, stringify({ filter, size: 100,
                sort: [{ field: 'key', order: 'ASC' }], ...(searchAfter ? { searchAfter } : {}) })!, headers, 'Operate migration discovery'));
            if (!page || !Array.isArray(page.items)) throw malformed();
            if (!page.items.length) return items;
            const batch = page.items.map(decode);
            for (const item of batch) {
                const key = BigInt(item.key);
                if (previousKey !== undefined && key <= previousKey) throw new Error('Operate migration discovery did not progress in ascending key order.');
                previousKey = key;
            }
            const cursor = page.sortValues;
            if (!Array.isArray(cursor) || !cursor.length ||
                !cursor.every((value) => typeof value === 'string' || isLosslessNumber(value) || value === null) ||
                decimalKey(cursor[0]) !== batch[batch.length - 1].key ||
                (searchAfter && stringify(cursor) === stringify(searchAfter))) {
                throw new Error('Operate migration discovery returned a missing or non-progressing pagination cursor.');
            }
            searchAfter = cursor;
            items.push(...batch);
        }
    }

    private async request(url: string, data: string, headers: Record<string, string>, operation: string, migration?: MigrationRequest): Promise<unknown> {
        let text: unknown;
        try {
            const response = await this.http.post(url, data, { headers, timeout: 30000, maxRedirects: 0,
                responseType: 'text', transformResponse: [(value: unknown) => value] });
            if (response.status !== (migration ? 204 : 200) ||
                (migration && response.data !== '' && response.data !== undefined && response.data !== null)) {
                throw new Error(`${operation} failed (HTTP ${response.status}).`);
            }
            if (migration) return undefined;
            text = response.data;
        } catch (error) {
            const response = axios.isAxiosError(error) ? error.response : undefined;
            const status = typeof response?.status === 'number' && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
                ? response.status : undefined;
            if (migration && status === 400) {
                const rejection = missingElement(response?.data, migration);
                if (rejection) throw rejection;
            }
            const unexpected = error instanceof Error ? error.message.match(/^.+ failed \(HTTP (\d{3})\)\.$/)?.[1] : undefined;
            throw new Error(`${operation} failed${status !== undefined || unexpected ? ` (HTTP ${status ?? unexpected})` : ''}. Check profile endpoints, credentials, permissions, and connectivity.`);
        }
        try {
            if (typeof text !== 'string') throw new Error();
            return parse(text);
        } catch { throw new Error(`${operation} returned malformed JSON.`); }
    }
}

function missingElement(body: unknown, request: MigrationRequest): MissingMigrationElement | undefined {
    // Axios uses responseType:text. Never serialize arbitrary injected objects or echo remote prose.
    if (typeof body !== 'string' || body.length > 65536 || Buffer.byteLength(body, 'utf8') > 65536) return undefined;
    let problem: Record<string, unknown> | undefined;
    try { problem = record(JSON.parse(body)); } catch { return undefined; }
    if (!problem || problem.title !== 'INVALID_ARGUMENT' || typeof problem.detail !== 'string' ||
        (problem.status !== undefined && problem.status !== 400) ||
        (problem.type !== undefined && typeof problem.type !== 'string') ||
        (problem.instance !== undefined && typeof problem.instance !== 'string')) return undefined;
    for (const [index, mapping] of request.mappingInstructions.entries()) {
        for (const side of ['source', 'target'] as const) {
            const id = mapping[`${side}ElementId`];
            // Compare the complete known engine message using only local request values.
            const expected = `Command 'MIGRATE' rejected with code 'INVALID_ARGUMENT': Expected to migrate process instance '${request.instanceKey}' but mapping instructions contain a non-existing ${side} element id '${id}'. Elements provided in mapping instructions must exist in the ${side} process definition.`;
            if (problem.detail === expected) return new MissingMigrationElement(side, index);
        }
    }
    return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function malformed(): Error { return new Error('Operate migration discovery returned a malformed response.'); }
function decimalKey(value: unknown): string {
    const text = isLosslessNumber(value) ? value.value : value;
    if (typeof text !== 'string' || !/^\d+$/.test(text)) throw malformed();
    const key = BigInt(text);
    if (key <= 0n || key > 9223372036854775807n) throw malformed();
    return key.toString();
}
function numericVersion(value: unknown): number {
    if (!isLosslessNumber(value) || !/^\d+$/.test(value.value)) throw malformed();
    const version = Number(value.value);
    if (!Number.isInteger(version) || version < 1 || version > 2147483647) throw malformed();
    return version;
}
function tenant(item: Record<string, unknown>): { tenantId?: string } {
    if (item.tenantId !== undefined && typeof item.tenantId !== 'string') throw malformed();
    return item.tenantId === undefined ? {} : { tenantId: item.tenantId as string };
}
