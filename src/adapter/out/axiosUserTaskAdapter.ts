import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { LosslessNumber, parse } from 'lossless-json';
import { UserTaskOutPort, UserTaskSession } from '../../application/ports/out/userTaskOutPort';
import { stringifyApiJson } from '../../domain/apiJson';
import { RestConnection } from '../../domain/restConnection';
import { UserTask, UserTaskFailure, userTaskKey } from '../../domain/userTask';
import { anonymousHttp } from './anonymousHttp';

export class AxiosUserTaskAdapter implements UserTaskOutPort {
    constructor(private readonly http: AxiosInstance = axios.create()) {}

    async connect(connection: RestConnection): Promise<UserTaskSession> {
        const http = connection.noAuth === true ? anonymousHttp(this.http) : this.http;
        const tasklist = tasklistRoot(connection.restUrl);
        if (tasklist) {
            // Select the read API before authenticating. Never share its token or
            // endpoint with gateway completion, even when a session is reused.
            return {
                search: async (key) => {
                    const searchConnection = { ...connection, ...(connection.oauth
                        ? { oauth: { ...connection.oauth, audience: 'tasklist.camunda.io' } } : {}) };
                    const headers = await this.authenticate(searchConnection, http, 'Tasklist OAuth authentication');
                    return this.search(http, headers, tasklist, key, true);
                },
                complete: async (key, variables) => {
                    const headers = await this.authenticate(connection, http);
                    await this.complete(http, headers, connection.restUrl, key, variables);
                },
            };
        }
        const headers = await this.authenticate(connection, http);
        return {
            search: (key) => this.search(http, headers, connection.restUrl, key),
            complete: (key, variables) => this.complete(http, headers, connection.restUrl, key, variables),
        };
    }

    private async authenticate(connection: RestConnection, http: AxiosInstance, operation = 'OAuth authentication'): Promise<Record<string, string>> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (connection.noAuth !== true && connection.oauth) {
            const { oAuthUrl, clientId, clientSecret, audience } = connection.oauth;
            const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
            if (audience !== undefined) form.set('audience', audience);
            const auth = await this.request({ method: 'POST', url: oAuthUrl, data: form.toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, operation, http, 200);
            const token = record(auth)?.access_token;
            if (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
                throw new UserTaskFailure(`${operation} returned an invalid access_token.`);
            }
            headers.Authorization = `Bearer ${token}`;
        }
        return headers;
    }

    private async complete(http: AxiosInstance, headers: Record<string, string>, root: string, key: string, variables: Record<string, unknown>): Promise<void> {
        await this.request({ method: 'POST', url: `${root}/user-tasks/${key}/completion`,
            headers, data: stringifyApiJson({ variables }) }, 'User task completion', http, 204);
    }

    private async search(http: AxiosInstance, headers: Record<string, string>, root: string, key?: string, tasklist = false): Promise<UserTask[]> {
        const tasks: UserTask[] = [];
        const keys = new Set<string>();
        const cursors = new Set<string>();
        let searchAfter: unknown[] | undefined;
        let previousCreation: number | undefined;
        for (;;) {
            const filter = { state: 'CREATED', ...(key === undefined ? {} : { processInstanceKey: key }) };
            const body = tasklist
                ? { ...filter, implementation: 'ZEEBE_USER_TASK', pageSize: 100,
                    sort: [{ field: 'creationTime', order: 'ASC' }], ...(searchAfter ? { searchAfter } : {}) }
                : { filter, sort: [{ field: 'creationDate', order: 'ASC' }],
                    page: { limit: 100, ...(searchAfter ? { searchAfter } : {}) } };
            const result = await this.request({ method: 'POST', url: `${root}/${tasklist ? 'tasks' : 'user-tasks'}/search`,
                headers, data: stringifyApiJson(body) }, tasklist ? 'Tasklist user task search' : 'User task search', http, 200);
            const envelope = record(result);
            const items = tasklist ? result : envelope?.items;
            if (!Array.isArray(items) || (!tasklist && !record(envelope?.page))) {
                throw new UserTaskFailure('User task search returned a malformed page.');
            }
            if (items.length === 0) return tasks;
            for (const item of items) {
                const task = taskResult(tasklist ? nativeTaskResult(item) : item);
                const creation = Date.parse(task.creationDate);
                // Creation dates, not unrelated numeric task keys, define the requested order.
                if (!Number.isFinite(creation) || (previousCreation !== undefined && creation < previousCreation)) {
                    throw new UserTaskFailure('User task search returned invalid creation-date ordering.');
                }
                if (keys.has(task.key) || (key !== undefined && task.processInstanceKey !== key)) {
                    throw new UserTaskFailure('User task search returned duplicate or mismatched results.');
                }
                previousCreation = creation;
                keys.add(task.key);
                tasks.push(task);
            }
            const cursor = tasklist ? record(items[items.length - 1])?.sortValues : record(envelope?.page)?.lastSortValues;
            if (!Array.isArray(cursor) || cursor.length === 0 || (tasklist && !cursor.every((value) => typeof value === 'string'))) {
                throw new UserTaskFailure('User task search returned a missing pagination cursor.');
            }
            const serialized = stringifyApiJson(cursor)!;
            if (cursors.has(serialized)) throw new UserTaskFailure('User task search pagination did not progress.');
            cursors.add(serialized);
            searchAfter = cursor;
        }
    }

    private async request(config: AxiosRequestConfig, operation: string, http: AxiosInstance, status: number): Promise<unknown> {
        let text: unknown;
        try {
            const response = await http.request({ ...config, timeout: 30000, maxRedirects: 0,
                responseType: 'text', transformResponse: [(value: unknown) => value] });
            if (response.status !== status) throw new UserTaskFailure(`${operation} returned an unexpected HTTP status.`);
            text = response.data;
        } catch (error) {
            if (error instanceof UserTaskFailure) throw error;
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            throw new UserTaskFailure(`${operation} failed${typeof status === 'number' ? ` (HTTP ${status})` : ''}. ` +
                (operation.startsWith('Tasklist ') && (status === 401 || status === 403)
                    ? 'Check Tasklist client permissions and token audience.'
                    : 'Check profile endpoints, credentials, permissions, and connectivity.'));
        }
        if (status === 204) {
            if (text !== '' && text !== undefined && text !== null) throw new UserTaskFailure(`${operation} returned a malformed acknowledgement.`);
            return undefined;
        }
        try {
            if (typeof text !== 'string') throw new Error();
            return parse(text);
        } catch { throw new UserTaskFailure(`${operation} returned malformed JSON.`); }
    }
}

function tasklistRoot(restUrl: string): string | undefined {
    const url = new URL(restUrl);
    const region = /^([a-z]{3}-[1-9]\d*)\.zeebe\.camunda\.io$/.exec(url.hostname)?.[1];
    const cluster = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/v2)?\/?$/i.exec(url.pathname)?.[1];
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || !region || !cluster) return undefined;
    return `https://${region}.tasklist.camunda.io/${cluster}/v1`;
}

function nativeTaskResult(value: unknown): unknown {
    const task = record(value);
    if (!task || task.implementation !== 'ZEEBE_USER_TASK' || task.taskState !== 'CREATED') {
        throw new UserTaskFailure('Tasklist search returned a malformed or non-native user task.');
    }
    return { ...task, key: task.id, elementId: task.taskDefinitionId, state: task.taskState };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof LosslessNumber)
        ? value as Record<string, unknown> : undefined;
}

function taskResult(value: unknown): UserTask {
    const task = record(value);
    try {
        if (!task || typeof task.key !== 'string' || typeof task.processInstanceKey !== 'string' ||
            userTaskKey(task.key) !== task.key || userTaskKey(task.processInstanceKey) !== task.processInstanceKey ||
            task.state !== 'CREATED' || typeof task.elementId !== 'string' || typeof task.creationDate !== 'string' ||
            (task.assignee !== undefined && task.assignee !== null && typeof task.assignee !== 'string')) throw new Error();
        return task as unknown as UserTask;
    } catch { throw new UserTaskFailure('User task search returned a malformed user task.'); }
}
