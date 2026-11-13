import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { LosslessNumber, parse } from 'lossless-json';
import { ProcessInstanceOutPort, ProcessInstanceSession } from '../../application/ports/out/processInstanceOutPort';
import { stringifyApiJson } from '../../domain/apiJson';
import { ProcessInstanceFailure } from '../../domain/processInstance';
import { RestConnection } from '../../domain/restConnection';
import { anonymousHttp } from './anonymousHttp';

export class AxiosProcessInstanceAdapter implements ProcessInstanceOutPort {
    constructor(private readonly http: AxiosInstance = axios.create()) {}

    async connect(connection: RestConnection): Promise<ProcessInstanceSession> {
        const http = connection.noAuth === true ? anonymousHttp(this.http) : this.http;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (connection.noAuth !== true && connection.oauth) {
            const { oAuthUrl, clientId, clientSecret, audience } = connection.oauth;
            const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
            if (audience !== undefined) form.set('audience', audience);
            const auth = await this.request({ method: 'POST', url: oAuthUrl, data: form.toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 'OAuth authentication');
            const token = record(auth)?.access_token;
            if (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
                throw new ProcessInstanceFailure('OAuth authentication returned an invalid access_token.');
            }
            headers.Authorization = `Bearer ${token}`;
        }
        return {
            create: async (request) => {
                const result = await this.request({ method: 'POST', url: `${connection.restUrl}/process-instances`,
                    headers, data: stringifyApiJson(request) }, 'Process instance creation', http, 200);
                const key = record(result)?.processInstanceKey;
                const text = key instanceof LosslessNumber ? key.value : key;
                if (typeof text !== 'string' || !/^\d+$/.test(text) || BigInt(text) < 1n || BigInt(text) > 9223372036854775807n) {
                    throw new ProcessInstanceFailure('Process instance creation returned a malformed processInstanceKey.');
                }
                return text;
            },
        };
    }

    private async request(config: AxiosRequestConfig, operation: string, http = this.http, expectedStatus?: number): Promise<unknown> {
        let text: unknown;
        try {
            const response = await http.request({ ...config, timeout: 30000, maxRedirects: 0,
                responseType: 'text', transformResponse: [(value: unknown) => value] });
            if (expectedStatus !== undefined && response.status !== expectedStatus) {
                throw new ProcessInstanceFailure(`${operation} returned an unexpected HTTP status.`);
            }
            text = response.data;
        } catch (error) {
            if (error instanceof ProcessInstanceFailure) throw error;
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            throw new ProcessInstanceFailure(`${operation} failed${typeof status === 'number' ? ` (HTTP ${status})` : ''}. ` +
                'Check profile endpoints, credentials, permissions, and connectivity.');
        }
        try {
            if (typeof text !== 'string') throw new Error();
            return parse(text);
        } catch { throw new ProcessInstanceFailure(`${operation} returned malformed JSON.`); }
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof LosslessNumber)
        ? value as Record<string, unknown> : undefined;
}
