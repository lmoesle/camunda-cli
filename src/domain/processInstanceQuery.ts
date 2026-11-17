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

export interface ProcessInstanceQueryFilter {
    key?: string;
    processDefinition?: string;
    activity?: string;
}

export interface ProcessInstanceQuery extends ProcessInstanceQueryFilter {
    includeVariables: boolean;
}

export function processInstanceFilter(filter: string | undefined): string | undefined {
    return processInstanceQueryFilter(filter).key;
}

export function processInstanceQueryFilter(filter: string | undefined): ProcessInstanceQueryFilter {
    if (filter === undefined) return {};
    const invalid = (): Error => new Error('Filter must be a JSON object with only "process-instance" (positive decimal int64 string), "processDefinition" and "activity" (nonblank BPMN ID strings). Activity requires processDefinition.');
    let value: unknown;
    try { value = JSON.parse(filter); } catch { throw invalid(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const object = value as Record<string, unknown>;
    if (Object.keys(object).some((key) => !['process-instance', 'processDefinition', 'activity'].includes(key))) throw invalid();
    const result: ProcessInstanceQueryFilter = {};
    if (Object.prototype.hasOwnProperty.call(object, 'process-instance')) {
        const key = object['process-instance'];
        if (typeof key !== 'string' || !/^\d+$/.test(key.trim())) throw invalid();
        const number = BigInt(key.trim());
        if (number <= 0n || number > 9223372036854775807n) throw invalid();
        result.key = number.toString();
    }
    for (const field of ['processDefinition', 'activity'] as const) {
        if (Object.prototype.hasOwnProperty.call(object, field)) {
            const id = object[field];
            if (typeof id !== 'string' || !id.trim()) throw invalid();
            result[field] = id;
        }
    }
    if (result.activity !== undefined && result.processDefinition === undefined) throw invalid();
    return result;
}
