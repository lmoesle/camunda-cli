import { Profile } from './profile';

export interface MigrationPlanEntry {
    processDefinition: string;
    sourceVersion: number;
    targetVersion: number;
    mappingInstructions: { sourceElementId: string; targetElementId: string }[];
}

export interface MigrationDefinition { key: string; bpmnProcessId: string; version: number; tenantId?: string }
export interface MigrationInstance { key: string; processDefinitionKey: string; state: 'ACTIVE'; tenantId?: string }
export interface MigrationConnection {
    gatewayUrl: string;
    operateUrl: string;
    oauth?: { clientId: string; clientSecret: string; oAuthUrl: string; audience?: string; operateAudience?: string };
}

export function migrationPlan(value: unknown): MigrationPlanEntry[] {
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { throw new Error('Migration plan must be valid JSON.'); }
    }
    if (!Array.isArray(value) || !value.length) throw new Error('Migration plan must be a nonempty array.');
    const seen = new Set<string>();
    return Array.from(value, (entry: unknown, index) => {
        const fail = (field: string): never => { throw new Error(`Migration plan entry ${index}: invalid ${field}.`); };
        const object = fields(entry, ['processDefinition', 'sourceVersion', 'targetVersion', 'mappingInstructions']);
        if (!object) return fail('fields');
        const processDefinition = identifier(object.processDefinition) ?? fail('processDefinition');
        const sourceVersion = version(object.sourceVersion) ?? fail('sourceVersion');
        const targetVersion = version(object.targetVersion) ?? fail('targetVersion');
        if (sourceVersion === targetVersion) fail('targetVersion (equals sourceVersion)');
        const selector = JSON.stringify([processDefinition, sourceVersion]);
        if (seen.has(selector)) fail('duplicate source selector');
        seen.add(selector);
        if (!Array.isArray(object.mappingInstructions)) return fail('mappingInstructions');
        const sources = new Set<string>();
        const mappingInstructions = Array.from(object.mappingInstructions, (mapping: unknown, mappingIndex) => {
            const instruction = fields(mapping, ['sourceElementId', 'targetElementId']);
            const field = `mappingInstructions[${mappingIndex}]`;
            if (!instruction) return fail(field);
            const sourceElementId = identifier(instruction.sourceElementId) ?? fail(`${field}.sourceElementId`);
            const targetElementId = identifier(instruction.targetElementId) ?? fail(`${field}.targetElementId`);
            if (sources.has(sourceElementId)) fail(`${field}.duplicate sourceElementId`);
            sources.add(sourceElementId);
            return { sourceElementId, targetElementId };
        });
        return { processDefinition, sourceVersion, targetVersion, mappingInstructions };
    });
}

function fields(value: unknown, allowed: string[]): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const object = value as Record<string, unknown>;
    return Object.keys(object).every((key) => allowed.includes(key)) ? object : undefined;
}

function identifier(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function version(value: unknown): number | undefined {
    if (typeof value === 'string' && /^v?\d+$/.test(value)) value = Number(value.replace(/^v/, ''));
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2147483647 ? value : undefined;
}

export function migrationConnection(profile: Profile): MigrationConnection {
    const gatewayUrl = endpoint(profile.baseUrl, 'baseUrl').replace(/\/v[12]$/, '') + '/v2';
    const operateUrl = endpoint(profile.operateUrl, 'operateUrl').replace(/\/v[12]$/, '') + '/v1';
    const saas = [gatewayUrl, operateUrl].some((url) => /\.(zeebe|operate)\.camunda\.io$/.test(new URL(url).hostname)) ||
        (profile.oAuthUrl !== undefined && new URL(endpoint(profile.oAuthUrl, 'oAuthUrl')).hostname === 'login.cloud.camunda.io');
    const authFields = ['clientId', 'clientSecret', 'oAuthUrl', 'audience', 'operateAudience'] as const;
    if (!saas && !authFields.some((field) => Object.prototype.hasOwnProperty.call(profile, field))) return { gatewayUrl, operateUrl };
    const clientId = required(profile.clientId, 'clientId');
    const clientSecret = required(profile.clientSecret, 'clientSecret');
    const oAuthUrl = endpoint(profile.oAuthUrl, 'oAuthUrl');
    const audience = saas || Object.prototype.hasOwnProperty.call(profile, 'audience') ? required(profile.audience, 'audience') : undefined;
    const operateAudience = saas || Object.prototype.hasOwnProperty.call(profile, 'operateAudience')
        ? required(profile.operateAudience, 'operateAudience') : audience;
    return { gatewayUrl, operateUrl, oauth: { clientId, clientSecret, oAuthUrl, audience, operateAudience } };
}

function required(value: string | undefined, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Profile ${field} is required and must not be blank for migrate.`);
    return value;
}

function endpoint(value: string | undefined, field: string): string {
    const text = required(value, field).trim();
    let url: URL;
    try { url = new URL(text); } catch { throw new Error(`Profile ${field} must be a valid HTTP(S) endpoint URL.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || text.includes('?') || text.includes('#')) {
        throw new Error(`Profile ${field} must use HTTP(S) without credentials, query, or fragment.`);
    }
    return url.toString().replace(/\/+$/, '');
}
