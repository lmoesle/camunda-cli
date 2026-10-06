import axios, { AxiosInstance } from 'axios';
import { isLosslessNumber, parse } from 'lossless-json';
import { DeploymentOutPort, DeploymentSession } from '../../application/ports/out/deploymentOutPort';
import { DeploymentConnection } from '../../domain/deployment';

export class AxiosDeploymentAdapter implements DeploymentOutPort {
    constructor(private readonly http: AxiosInstance = axios.create()) {}

    async connect(connection: DeploymentConnection): Promise<DeploymentSession> {
        const headers: Record<string, string> = {};
        if (connection.oauth) {
            const { oAuthUrl, clientId, clientSecret, audience } = connection.oauth;
            const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
            if (audience !== undefined) form.set('audience', audience);
            const auth = await this.request(oAuthUrl, form.toString(), {
                'Content-Type': 'application/x-www-form-urlencoded',
            }, 'OAuth authentication');
            const token = record(auth)?.access_token;
            if (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
                throw new Error('OAuth authentication returned an invalid access_token.');
            }
            headers.Authorization = `Bearer ${token}`;
        }
        return {
            deploy: async (resource) => {
                const form = new FormData();
                form.append('resources', new Blob([new Uint8Array(resource.bytes)], { type: 'application/octet-stream' }), resource.filename);
                const response = await this.request(connection.deploymentsUrl, form, headers, 'Resource deployment');
                const key = record(response)?.deploymentKey;
                const text = isLosslessNumber(key) ? key.value : key;
                if (typeof text !== 'string' || !/^\d+$/.test(text) || BigInt(text) > 9223372036854775807n) {
                    throw new Error('Resource deployment returned a malformed deploymentKey.');
                }
                return text;
            },
        };
    }

    private async request(url: string, data: string | FormData, headers: Record<string, string>, operation: string): Promise<unknown> {
        let text: unknown;
        try {
            const response = await this.http.post(url, data, {
                headers, timeout: 30000, maxRedirects: 0, responseType: 'text', transformResponse: [(value: unknown) => value],
            });
            text = response.data;
        } catch (error) {
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            // eslint-disable-next-line preserve-caught-error -- Axios causes expose credentials, request configs, and response data.
            throw new Error(`${operation} failed${typeof status === 'number' ? ` (HTTP ${status})` : ''}. ` +
                'Check profile endpoints, credentials, permissions, and connectivity.');
        }
        try {
            if (typeof text !== 'string') throw new Error();
            return parse(text);
        } catch { throw new Error(`${operation} returned malformed JSON.`); }
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
