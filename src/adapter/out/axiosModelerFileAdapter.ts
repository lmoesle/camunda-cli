import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, isAxiosError } from 'axios';
import { ModelerFileOutPort } from '../../application/ports/out/modelerFileOutPort';
import { ModelerFile, ModelerFileMetadata, ModelerVersion } from '../../domain/modelerFile';

const pageSize = 50;

interface SearchResult<T> {
    items: T[];
    total: number;
}

export const defaultModelerApiBaseUrl = 'https://modeler.camunda.io/api/v1';

export class AxiosModelerFileAdapter implements ModelerFileOutPort {
    private readonly httpClient: AxiosInstance;

    constructor(baseUrl = defaultModelerApiBaseUrl, httpClient?: AxiosInstance) {
        this.httpClient = httpClient ?? axios.create({ baseURL: baseUrl });
    }

    async findAllFiles(bearerToken: string, modelerApiUrl?: string): Promise<ModelerFileMetadata[]> {
        const files = new Map<string, ModelerFileMetadata>();
        let page = 0;
        let receivedFiles = 0;

        while (true) {
            const result = await this.request<SearchResult<ModelerFileMetadata>>(
                {
                    method: 'POST',
                    url: '/files/search',
                    data: { filter: {}, page, size: pageSize },
                    ...requestConfig(bearerToken, modelerApiUrl),
                },
                'list Modeler files',
            );

            for (const file of result.items) {
                files.set(file.id, file);
            }

            receivedFiles += result.items.length;

            if (isLastPage(result, receivedFiles)) {
                break;
            }

            page += 1;
        }

        return Array.from(files.values());
    }

    async getFile(bearerToken: string, fileId: string, modelerApiUrl?: string): Promise<ModelerFile> {
        return this.request<ModelerFile>(
            {
                method: 'GET',
                url: `/files/${encodeURIComponent(fileId)}`,
                ...requestConfig(bearerToken, modelerApiUrl),
            },
            `download Modeler file ${fileId}`,
        );
    }

    async getVersion(bearerToken: string, versionId: string, modelerApiUrl?: string): Promise<ModelerVersion> {
        return this.request<ModelerVersion>(
            {
                method: 'GET',
                url: `/versions/${encodeURIComponent(versionId)}`,
                ...requestConfig(bearerToken, modelerApiUrl),
            },
            `download Modeler file version ${versionId}`,
        );
    }

    private async request<T>(config: AxiosRequestConfig, operation: string): Promise<T> {
        try {
            const response = await this.httpClient.request<T>(config);
            return response.data;
        } catch (error: unknown) {
            if (isAxiosError(error)) {
                throw translateAxiosError(error, operation);
            }

            throw error;
        }
    }
}

function isLastPage(result: SearchResult<ModelerFileMetadata>, receivedFiles: number): boolean {
    return result.items.length === 0 || result.items.length < pageSize || receivedFiles >= result.total;
}

function translateAxiosError(error: AxiosError, operation: string): Error {
    const response = error.response;
    if (!response) {
        return requestFailure(operation, undefined, error.message);
    }
    if (response.status === 401) {
        return new Error('The bearer token is invalid or expired.');
    }
    const reason = getApiErrorMessage(response.data) ?? error.message;
    return requestFailure(operation, response.status, reason);
}

function requestFailure(operation: string, statusCode: number | undefined, reason: string): Error {
    const status = statusCode ? `HTTP ${statusCode}: ` : '';
    return new Error(`Failed to ${operation}: ${status}${reason}`);
}

function requestConfig(bearerToken: string, modelerApiUrl?: string): AxiosRequestConfig {
    return {
        ...(modelerApiUrl ? { baseURL: modelerApiUrl } : {}),
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${bearerToken}`,
        },
    };
}

function getApiErrorMessage(responseData: unknown): string | undefined {
    if (typeof responseData !== 'object' || responseData === null) {
        return undefined;
    }

    return firstProblemMessage(responseData as Record<string, unknown>);
}

function firstProblemMessage(problemDetails: Record<string, unknown>): string | undefined {
    for (const property of ['detail', 'message', 'title']) {
        const value = stringProperty(problemDetails, property);
        if (value !== undefined) {
            return value;
        }
    }

    return undefined;
}

function stringProperty(record: Record<string, unknown>, property: string): string | undefined {
    if (!(property in record)) {
        return undefined;
    }
    const value = record[property];
    return typeof value === 'string' ? value : undefined;
}
