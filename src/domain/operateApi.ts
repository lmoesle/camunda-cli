import { LosslessNumber, parse } from 'lossless-json';
import { stringifyApiJson } from './apiJson';
import { ApiOperation, ApiSchema, OperateMetadata, OperateRequest } from './operateApiTypes';

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof LosslessNumber);
}

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function invalid(): never {
    // Never echo request values (which may contain secrets) or parser exceptions.
    throw new Error('Invalid API request. Use path/query objects and a body matching the pinned Operate 8.7 OpenAPI schema.');
}

function resolve(schema: ApiSchema, metadata: OperateMetadata): ApiSchema {
    if (!schema.$ref) return schema;
    const prefix = '#/components/schemas/';
    const name = schema.$ref.slice(prefix.length);
    if (!schema.$ref.startsWith(prefix) || !hasOwn(metadata.schemas, name)) invalid();
    return metadata.schemas[name];
}

function integer(value: unknown): bigint {
    if (!(value instanceof LosslessNumber)) invalid();
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value.value);
    if (!match) invalid();
    const digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
    if (!digits) return 0n;
    const shift = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
    if (!Number.isSafeInteger(shift) || shift > 20 || shift < -digits.length) invalid();
    let whole = digits;
    if (shift < 0) {
        if (!/^0+$/.test(digits.slice(shift))) invalid();
        whole = digits.slice(0, shift);
    } else whole += '0'.repeat(shift);
    if (whole.length > 20) invalid();
    return BigInt(match[1] + whole);
}

function validate(value: unknown, unresolved: ApiSchema, metadata: OperateMetadata): void {
    const schema = resolve(unresolved, metadata);
    if (schema.enum && !schema.enum.some((entry) => stringifyApiJson(entry) === stringifyApiJson(value))) invalid();
    switch (schema.type) {
        case 'integer': {
            const number = integer(value);
            const bits = schema.format === 'int32' ? 32n : 64n;
            if (number < -(2n ** (bits - 1n)) || number >= 2n ** (bits - 1n)) invalid();
            break;
        }
        case 'string': if (typeof value !== 'string') invalid(); break;
        case 'boolean': if (typeof value !== 'boolean') invalid(); break;
        case 'array':
            if (!Array.isArray(value)) invalid();
            for (const entry of value) validate(entry, schema.items ?? {}, metadata);
            break;
        case 'object': validateObject(value, schema, metadata); break;
        case undefined: break;
        default: invalid();
    }
}

function validateObject(value: unknown, schema: ApiSchema, metadata: OperateMetadata): void {
    if (!object(value)) invalid();
    for (const key of schema.required ?? []) if (!hasOwn(value, key)) invalid();
    for (const [key, entry] of Object.entries(value)) {
        const property = schema.properties && hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
        if (property) validate(entry, property, metadata);
        else if (schema.additionalProperties === false) invalid();
        else if (object(schema.additionalProperties)) validate(entry, schema.additionalProperties, metadata);
    }
}

function parameterText(value: unknown, schema: ApiSchema, metadata: OperateMetadata): string {
    validate(value, schema, metadata);
    if (resolve(schema, metadata).type === 'integer') return integer(value).toString();
    if (typeof value !== 'string' && typeof value !== 'boolean') invalid();
    return String(value);
}

function envelope(json: string): { path: Record<string, unknown>; query: Record<string, unknown>; body?: unknown } {
    let input: unknown;
    try { input = parse(json); } catch { invalid(); }
    if (!object(input) || Object.keys(input).some((key) => !['path', 'query', 'body'].includes(key))) invalid();
    const pathValues = input.path ?? {};
    const queryValues = input.query ?? {};
    if (!object(pathValues) || !object(queryValues) || input.path === null || input.query === null) invalid();
    return { path: pathValues, query: queryValues, ...(hasOwn(input, 'body') ? { body: input.body } : {}) };
}

function parameters(operation: ApiOperation, location: string, values: Record<string, unknown>, metadata: OperateMetadata): [string, string][] {
    const definitions = operation.parameters.filter((parameter) => parameter.in === location);
    if (Object.keys(values).some((key) => !definitions.some((parameter) => parameter.name === key))) invalid();
    const result: [string, string][] = [];
    for (const parameter of definitions) {
        if (!hasOwn(values, parameter.name)) {
            if (parameter.required) invalid();
            continue;
        }
        result.push([parameter.name, parameterText(values[parameter.name], parameter.schema, metadata)]);
    }
    return result;
}

function requestBody(operation: ApiOperation, input: { body?: unknown }, metadata: OperateMetadata): { body: string } | Record<string, never> {
    if (!hasOwn(input, 'body')) {
        if (operation.requestBody?.required) invalid();
        return {};
    }
    const schema = operation.requestBody?.content['application/json']?.schema;
    if (!schema) invalid();
    validate(input.body, schema, metadata);
    return { body: stringifyApiJson(input.body)! };
}

export function validateOperateRequest(operationId: string, json: string, metadata: OperateMetadata): OperateRequest {
    const operation = metadata.operations.find((entry) => entry.operationId === operationId);
    if (!operation) throw new Error('Unknown Operate API operation. Run api ls to list operationIds.');
    const input = envelope(json);
    let path = operation.path;
    const pathArguments = Object.fromEntries(parameters(operation, 'path', input.path, metadata));
    for (const [name, text] of Object.entries(pathArguments)) {
        // WHATWG URLs normalize dot segments even when percent-encoded.
        if (text === '.' || text === '..' || text === '') invalid();
        path = path.replace(`{${name}}`, encodeURIComponent(text));
    }
    if (/\{[^}]+\}/.test(path)) invalid();
    const queryArguments = Object.fromEntries(parameters(operation, 'query', input.query, metadata));
    const query = new URLSearchParams(queryArguments).toString();
    return { operationId, pathArguments, queryArguments, method: operation.method, path, query, ...requestBody(operation, input, metadata) };
}
