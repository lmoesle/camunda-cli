import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { parse } from 'lossless-json';
import { OperateApiOutPort } from '../../application/ports/out/operateApiOutPort';
import { OperateConnection } from '../../domain/operateConnection';
import { OperateRequest } from '../../domain/operateApiTypes';
import { assertReadOnlyOperateDispatch } from '../../domain/operateApiPolicy';
import { dispatchOperateRequest } from './operateApiDispatch';

export class AxiosOperateApiAdapter implements OperateApiOutPort {
    constructor(private readonly http: AxiosInstance = axios.create()) {}

    async execute(connection: OperateConnection, request: OperateRequest): Promise<unknown> {
        assertReadOnlyOperateDispatch(request);
        const form = new URLSearchParams({
            grant_type: 'client_credentials', client_id: connection.clientId, client_secret: connection.clientSecret,
        });
        if (connection.audience !== undefined) form.set('audience', connection.audience);
        const auth = await this.request('POST', connection.oAuthUrl, form.toString(), {
            'Content-Type': 'application/x-www-form-urlencoded',
        }, 'OAuth authentication');
        const authentication = json(auth.data, 'OAuth authentication');
        const token = authentication !== null && typeof authentication === 'object'
            ? (authentication as Record<string, unknown>).access_token : undefined;
        if (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
            throw new Error('OAuth authentication returned an invalid access_token.');
        }
        const root = connection.operateUrl.endsWith('/v1') ? connection.operateUrl.slice(0, -3) : connection.operateUrl;
        let response: AxiosResponse<unknown>;
        try {
            response = await dispatchOperateRequest(this.http, root, token, request);
        } catch (error) {
            throw sanitized(error, 'Operate API request');
        }
        if (response.status === 204 || response.status === 205 || response.data === '' || response.data === undefined || response.data === null) return null;
        const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (contentType === 'application/json' || contentType.endsWith('+json')) return json(response.data, 'Operate API request');
        if (typeof response.data !== 'string') throw new Error('Operate API request returned an invalid response.');
        return response.data;
    }

    private async request(method: string, url: string, data: string | undefined, headers: Record<string, string>, operation: string): Promise<AxiosResponse<unknown>> {
        try {
            return await this.http.request({
                method, url, data, headers, timeout: 30000, maxRedirects: 0,
                responseType: 'text', transformResponse: [(value: unknown) => value],
            });
        } catch (error) {
            throw sanitized(error, operation);
        }
    }
}

function sanitized(error: unknown, operation: string): Error {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const detail = typeof status === 'number' ? ` (HTTP ${status})` : '';
    // Do not retain Axios causes: they expose credentials and request/response data.
    return new Error(`${operation} failed${detail}. Check profile endpoints, credentials, permissions, and connectivity.`);
}

function json(text: unknown, operation: string): unknown {
    try {
        if (typeof text !== 'string') throw new Error();
        return parse(text);
    } catch {
        throw new Error(`${operation} returned malformed JSON.`);
    }
}
