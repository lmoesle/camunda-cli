import axios, { AxiosInstance } from 'axios';
import { isLosslessNumber, parse, stringify } from 'lossless-json';
import { IncidentConnection, IncidentSearchOutPort } from '../../application/ports/out/incidentSearchOutPort';
import { Incident } from '../../domain/incident';

export class AxiosIncidentAdapter implements IncidentSearchOutPort {
    constructor(private readonly http: AxiosInstance = axios.create()) {}

    async searchActiveIncidents(connection: IncidentConnection): Promise<Incident[]> {
        const form = new URLSearchParams({
            grant_type: 'client_credentials', client_id: connection.clientId, client_secret: connection.clientSecret,
        });
        if (connection.audience !== undefined) form.set('audience', connection.audience);
        const auth = await this.request(connection.oAuthUrl, form.toString(), {
            'Content-Type': 'application/x-www-form-urlencoded',
        }, 'OAuth authentication');
        const token = record(auth)?.access_token;
        if (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
            throw new Error('OAuth authentication returned an invalid access_token.');
        }
        const url = `${connection.operateUrl}${connection.operateUrl.endsWith('/v1') ? '' : '/v1'}/incidents/search`;
        const incidents: Incident[] = [];
        let searchAfter: unknown[] | undefined;
        let previousKey: bigint | undefined;
        for (;;) {
            const page = record(await this.request(url, stringify({
                filter: { state: 'ACTIVE' }, size: 100, sort: [{ field: 'key', order: 'ASC' }],
                ...(searchAfter ? { searchAfter } : {}),
            })!, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, 'Operate incident search'));
            if (!page || !Array.isArray(page.items)) throw malformed();
            if (page.items.length === 0) return incidents;
            const items = page.items.map(incident);
            for (const item of items) {
                const key = BigInt(item.key);
                if (previousKey !== undefined && key <= previousKey) {
                    throw new Error('Operate incident search did not progress in ascending key order.');
                }
                previousKey = key;
            }
            const cursor = page.sortValues;
            if (!Array.isArray(cursor) || cursor.length === 0 ||
                !cursor.every((value) => typeof value === 'string' || isLosslessNumber(value) || value === null) ||
                decimalKey(cursor[0]) !== items[items.length - 1].key ||
                (searchAfter && stringify(cursor) === stringify(searchAfter))) {
                throw new Error('Operate incident search returned a missing or non-progressing pagination cursor.');
            }
            searchAfter = cursor;
            incidents.push(...items);
        }
    }

    private async request(url: string, data: string, headers: Record<string, string>, operation: string): Promise<unknown> {
        let text: unknown;
        try {
            const response = await this.http.post(url, data, {
                headers, timeout: 30000, maxRedirects: 0, responseType: 'text', transformResponse: [(value: unknown) => value],
            });
            text = response.data;
        } catch (error) {
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            const detail = typeof status === 'number' ? ` (HTTP ${status})` : '';
            // eslint-disable-next-line preserve-caught-error -- Axios causes expose credentials, request configs, and response data.
            throw new Error(`${operation} failed${detail}. Check profile endpoints, credentials, permissions, and connectivity.`);
        }
        try {
            if (typeof text !== 'string') throw new Error();
            return parse(text);
        } catch {
            throw new Error(`${operation} returned malformed JSON.`);
        }
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function malformed(): Error {
    return new Error('Operate incident search returned a malformed incident response.');
}

function decimalKey(value: unknown): string {
    const text = isLosslessNumber(value) ? value.value : value;
    if (typeof text !== 'string' || !/^\d+$/.test(text)) throw malformed();
    const key = BigInt(text);
    if (key > 9223372036854775807n) throw malformed();
    return key.toString();
}

function incident(value: unknown): Incident {
    const item = record(value);
    if (!item || item.state !== 'ACTIVE' ||
        !['type', 'message', 'creationTime'].every((field) => typeof item[field] === 'string') ||
        (item.tenantId !== undefined && typeof item.tenantId !== 'string')) throw malformed();
    return {
        key: decimalKey(item.key), processInstanceKey: decimalKey(item.processInstanceKey),
        type: item.type as string, message: item.message as string, creationTime: item.creationTime as string,
        state: 'ACTIVE',
        ...(item.processDefinitionKey !== undefined ? { processDefinitionKey: decimalKey(item.processDefinitionKey) } : {}),
        ...(item.jobKey !== undefined ? { jobKey: decimalKey(item.jobKey) } : {}),
        ...(item.tenantId !== undefined ? { tenantId: item.tenantId as string } : {}),
    };
}
