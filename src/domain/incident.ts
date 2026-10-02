/** Operate int64 identifiers are decimal strings, never JavaScript numbers. */
export interface Incident {
    key: string;
    processInstanceKey: string;
    processDefinitionKey?: string;
    jobKey?: string;
    type: string;
    message: string;
    creationTime: string;
    state: 'ACTIVE';
    tenantId?: string;
}
