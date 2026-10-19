import { Profile } from './profile';

export interface OperateConnection {
    operateUrl: string;
    oAuthUrl: string;
    clientId: string;
    clientSecret: string;
    audience?: string;
}

function required(value: string | undefined, field: string, operation: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Profile ${field} is required and must not be blank for ${operation}.`);
    }
    return value;
}

function endpoint(value: string | undefined, field: string, operation: string): string {
    const text = required(value, field, operation).trim();
    let url: URL;
    try { url = new URL(text); } catch { throw new Error(`Profile ${field} must be a valid HTTP(S) endpoint URL.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || text.includes('?') || text.includes('#')) {
        throw new Error(`Profile ${field} must use HTTP(S) without credentials, query, or fragment.`);
    }
    return url.toString().replace(/\/+$/, '');
}

export function operateConnection(profile: Profile, operation: string): OperateConnection {
    const operateUrl = endpoint(profile.operateUrl, 'operateUrl', operation);
    const oAuthUrl = endpoint(profile.oAuthUrl, 'oAuthUrl', operation);
    const clientId = required(profile.clientId, 'clientId', operation);
    const clientSecret = required(profile.clientSecret, 'clientSecret', operation);
    const saas = new URL(operateUrl).hostname.endsWith('.operate.camunda.io') ||
        new URL(oAuthUrl).hostname === 'login.cloud.camunda.io';
    const audience = Object.prototype.hasOwnProperty.call(profile, 'operateAudience')
        ? required(profile.operateAudience, 'operateAudience', operation)
        : profile.audience !== undefined || saas ? required(profile.audience, 'audience', operation) : undefined;
    return { operateUrl, oAuthUrl, clientId, clientSecret, audience };
}
