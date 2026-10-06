import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { IncidentRetryOutPort, IncidentRetrySession } from '../../application/ports/out/incidentRetryOutPort';
import { IncidentRetryFailure } from '../../domain/incidentRetry';
import { RestConnection } from '../../domain/restConnection';

export class AxiosIncidentRetryAdapter implements IncidentRetryOutPort {
    constructor(private readonly http: AxiosInstance = axios.create()) {}

    async connect(connection: RestConnection): Promise<IncidentRetrySession> {
        const headers: Record<string, string> = {};
        if (connection.oauth) {
            const { oAuthUrl, clientId, clientSecret, audience } = connection.oauth;
            const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
            if (audience !== undefined) form.set('audience', audience);
            const text = await this.request({ method: 'POST', url: oAuthUrl, data: form.toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 'OAuth authentication');
            let token: unknown;
            try { token = (JSON.parse(text as string) as { access_token?: unknown } | null)?.access_token; }
            catch { throw new IncidentRetryFailure('OAuth authentication returned malformed JSON.'); }
            if (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
                throw new IncidentRetryFailure('OAuth authentication returned an invalid access_token.');
            }
            headers.Authorization = `Bearer ${token}`;
        }
        return {
            resetJobRetries: async (jobKey) => {
                await this.request({ method: 'PATCH', url: `${connection.restUrl}/jobs/${jobKey}`,
                    data: { changeset: { retries: 3 } }, headers }, 'Job retries update');
            },
            resolveIncident: async (incidentKey) => {
                // Override Axios's form media type fallback for bodyless POST requests.
                await this.request({ method: 'POST', url: `${connection.restUrl}/incidents/${incidentKey}/resolution`,
                    headers: { ...headers, 'Content-Type': 'application/json' } }, 'Incident resolution');
            },
        };
    }

    private async request(config: AxiosRequestConfig, operation: string): Promise<unknown> {
        try {
            const response = await this.http.request({ ...config, timeout: 30000, maxRedirects: 0,
                responseType: 'text', transformResponse: [(value: unknown) => value] });
            return response.data;
        } catch (error) {
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            throw new IncidentRetryFailure(`${operation} failed${typeof status === 'number' ? ` (HTTP ${status})` : ''}. ` +
                'Check profile endpoints, credentials, permissions, and connectivity.');
        }
    }
}
