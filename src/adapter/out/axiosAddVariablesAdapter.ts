import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { AddVariablesOutPort, AddVariablesSession } from '../../application/ports/out/addVariablesOutPort';
import { AddVariablesFailure } from '../../domain/addVariables';
import { stringifyApiJson } from '../../domain/apiJson';
import { RestConnection } from '../../domain/restConnection';
import { anonymousHttp } from './anonymousHttp';

export class AxiosAddVariablesAdapter implements AddVariablesOutPort {
    constructor(private readonly http: AxiosInstance = axios.create()) {}

    async connect(connection: RestConnection): Promise<AddVariablesSession> {
        const http = connection.noAuth === true ? anonymousHttp(this.http) : this.http;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (connection.noAuth !== true && connection.oauth) {
            const { oAuthUrl, clientId, clientSecret, audience } = connection.oauth;
            const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
            if (audience !== undefined) form.set('audience', audience);
            const text = await this.request({ method: 'POST', url: oAuthUrl, data: form.toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 'OAuth authentication', http);
            let token: unknown;
            try { token = (JSON.parse(text as string) as { access_token?: unknown } | null)?.access_token; }
            catch { throw new AddVariablesFailure('OAuth authentication returned malformed JSON.'); }
            if (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
                throw new AddVariablesFailure('OAuth authentication returned an invalid access_token.');
            }
            headers.Authorization = `Bearer ${token}`;
        }
        return {
            update: async (key, variables) => {
                await this.request({ method: 'PUT', url: `${connection.restUrl}/element-instances/${key}/variables`,
                    headers, data: stringifyApiJson({ variables, local: true }) }, 'Variable update', http, true);
            },
        };
    }

    private async request(config: AxiosRequestConfig, operation: string, http: AxiosInstance, empty = false): Promise<unknown> {
        try {
            const response = await http.request({ ...config, timeout: 30000, maxRedirects: 0,
                responseType: 'text', transformResponse: [(value: unknown) => value] });
            if (empty && (response.status !== 204 || response.data !== '')) {
                throw new AddVariablesFailure(`${operation} returned an unexpected response (HTTP ${response.status}).`);
            }
            return response.data;
        } catch (error) {
            if (error instanceof AddVariablesFailure) throw error;
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            throw new AddVariablesFailure(`${operation} failed${typeof status === 'number' ? ` (HTTP ${status})` : ''}. ` +
                'Check profile endpoints, credentials, permissions, and connectivity.');
        }
    }
}
