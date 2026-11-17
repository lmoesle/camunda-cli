export interface ProcessInstanceVariable {
    key: string;
    processInstanceKey: string;
    scopeKey: string;
    name: string;
    /** Operate's JSON-encoded value, preserved verbatim. */
    value: string;
    truncated: false;
    tenantId?: string;
}

export interface QueriedProcessInstance {
    key: string;
    processDefinitionKey?: string;
    parentKey?: string | null;
    parentFlowNodeInstanceKey?: string | null;
    bpmnProcessId: string;
    processVersion: number;
    processVersionTag?: string;
    state: 'ACTIVE';
    incident: boolean;
    startDate: string;
    endDate?: string | null;
    tenantId?: string;
    variables: ProcessInstanceVariable[];
}

export interface ProcessInstanceQuery {
    key?: string;
    includeVariables: boolean;
}

export function processInstanceFilter(filter: string | undefined): string | undefined {
    if (filter === undefined) return undefined;
    const invalid = (): Error => new Error('Filter must be a JSON object with only "process-instance": a positive decimal int64 string.');
    let value: unknown;
    try { value = JSON.parse(filter); } catch { throw invalid(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const object = value as Record<string, unknown>;
    if (Object.keys(object).some((key) => key !== 'process-instance')) throw invalid();
    if (!Object.prototype.hasOwnProperty.call(object, 'process-instance')) return undefined;
    const key = object['process-instance'];
    if (typeof key !== 'string' || !/^\d+$/.test(key.trim())) throw invalid();
    const number = BigInt(key.trim());
    if (number <= 0n || number > 9223372036854775807n) throw invalid();
    return number.toString();
}
