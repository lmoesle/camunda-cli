import { parseVariables } from './variables';

export interface ProcessInstanceRequest {
    processDefinitionId: string;
    processDefinitionVersion: number;
    variables: Record<string, unknown>;
}

export function processInstanceRequest(id: string, version: string, variables: string): ProcessInstanceRequest {
    if (typeof id !== 'string' || !id.trim()) throw new Error('The process definition ID must be nonblank.');
    const text = typeof version === 'string' ? version.trim() : '';
    if (!/^(?:-1|\d+)$/.test(text) || (text !== '-1' && (BigInt(text) < 1n || BigInt(text) > 2147483647n))) {
        throw new Error('The process version must be a decimal integer from 1 to 2147483647, or -1 for latest.');
    }
    return { processDefinitionId: id, processDefinitionVersion: Number(text), variables: parseVariables(variables) };
}

// Only sanitized diagnostics may cross the adapter boundary.
export class ProcessInstanceFailure extends Error {}
