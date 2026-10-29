import { ApiOperation, OperateRequest } from './operateApiTypes';

// Reviewed read-only operationId/method/path tuples from the pinned Operate 8.7 spec.
// Neither an unfamiliar GET nor a POST ending in /search is implicitly safe.
const reads: readonly (readonly [string, string, string])[] = [
    ['search', 'POST', '/v1/variables/search'],
    ['search_1', 'POST', '/v1/process-instances/search'],
    ['search_2', 'POST', '/v1/process-definitions/search'],
    ['search_3', 'POST', '/v1/incidents/search'],
    ['search_4', 'POST', '/v1/flownode-instances/search'],
    ['search_5', 'POST', '/v1/drd/search'],
    ['search_6', 'POST', '/v1/decision-instances/search'],
    ['search_7', 'POST', '/v1/decision-definitions/search'],
    ['byKey', 'GET', '/v1/variables/{key}'],
    ['byKey_1', 'GET', '/v1/process-instances/{key}'],
    ['getStatistics', 'GET', '/v1/process-instances/{key}/statistics'],
    ['sequenceFlowsByKey', 'GET', '/v1/process-instances/{key}/sequence-flows'],
    ['byKey_2', 'GET', '/v1/process-definitions/{key}'],
    ['xmlByKey', 'GET', '/v1/process-definitions/{key}/xml'],
    ['byKey_3', 'GET', '/v1/incidents/{key}'],
    ['byKey_4', 'GET', '/v1/flownode-instances/{key}'],
    ['byKey_5', 'GET', '/v1/drd/{key}'],
    ['xmlByKey_1', 'GET', '/v1/drd/{key}/xml'],
    ['byId', 'GET', '/v1/decision-instances/{id}'],
    ['byKey_6', 'GET', '/v1/decision-definitions/{key}'],
];

function denied(): never {
    throw new Error('Unknown or unsupported Operate API operation. Only reviewed read-only requests are supported. Run api ls for supported operations. For write, change, or delete support, submit a feature request: https://github.com/lmoesle/camunda-cli/issues/new');
}

export function isReadOnlyOperateOperation(operation: Pick<ApiOperation, 'operationId' | 'method' | 'path'>): boolean {
    return reads.some(([id, method, path]) => id === operation.operationId && method === operation.method && path === operation.path);
}

export function assertReadOnlyOperateOperation(operation: Pick<ApiOperation, 'operationId' | 'method' | 'path'> | undefined): asserts operation is Pick<ApiOperation, 'operationId' | 'method' | 'path'> {
    if (!operation || !isReadOnlyOperateOperation(operation)) denied();
}

// Legacy discovery supplies only an operationId and body. If callers also supply
// transport metadata, require it to agree with the reviewed generated route.
export function assertReadOnlyOperateDispatch(request: Pick<OperateRequest, 'operationId'> & Partial<OperateRequest>): void {
    const approved = reads.find(([id]) => id === request.operationId);
    if (!approved) denied();
    const [, method, template] = approved;
    if (request.method !== undefined && request.method !== method) denied();
    const path = template.replace(/\{([^}]+)\}/g, (_placeholder, name: string) => {
        const value = request.pathArguments?.[name];
        // WHATWG URLs normalize dot segments even when percent-encoded.
        if (typeof value !== 'string' || value === '' || value === '.' || value === '..') denied();
        return encodeURIComponent(value);
    });
    if (request.path !== undefined && request.path !== path) denied();
}
