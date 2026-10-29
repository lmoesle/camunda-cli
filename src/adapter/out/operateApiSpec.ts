import { parse } from 'yaml';
import source from '../../../resources/operate-8.7/operate-openapi.yaml';
import { ApiOperation, ApiParameter, OperateMetadata } from '../../domain/operateApiTypes';
import { validateOperateRequest } from '../../domain/operateApi';
import { isReadOnlyOperateOperation } from '../../domain/operateApiPolicy';

// Read the checked-in official spec, not a second generated schema registry.
const spec = parse(source) as {
    paths: Record<string, Record<string, Omit<ApiOperation, 'method' | 'path' | 'parameters'> & { parameters?: ApiParameter[] }>>;
    components: { schemas: OperateMetadata['schemas'] };
};
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
export const operateMetadata: OperateMetadata = {
    operations: Object.entries(spec.paths).flatMap(([path, item]) =>
        Object.entries(item).filter(([method]) => methods.has(method)).map(([method, operation]) => ({
            operationId: operation.operationId, path, method: method.toUpperCase(), summary: operation.summary ?? '',
            parameters: operation.parameters ?? [],
            ...(operation.requestBody ? { requestBody: operation.requestBody } : {}),
        }))),
    schemas: spec.components.schemas,
};

export function listOperateOperations(): ApiOperation[] {
    return operateMetadata.operations.filter(isReadOnlyOperateOperation);
}

export function prepareOperateRequest(operationId: string, json: string) {
    return validateOperateRequest(operationId, json, operateMetadata);
}
