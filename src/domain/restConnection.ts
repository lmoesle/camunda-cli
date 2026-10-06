import { Profile } from './profile';

export interface RestConnection {
    restUrl: string;
    oauth?: { oAuthUrl: string; clientId: string; clientSecret: string; audience?: string };
}

export function restConnection(profile: Profile, operation: string): RestConnection {
    const root = endpoint(profile.baseUrl, 'baseUrl', operation);
    const restUrl = `${root}${root.endsWith('/v2') ? '' : '/v2'}`;
    const fields = ['clientId', 'clientSecret', 'oAuthUrl', 'audience'] as const;
    if (!fields.some((field) => Object.prototype.hasOwnProperty.call(profile, field))) return { restUrl };
    const oAuthUrl = endpoint(profile.oAuthUrl, 'oAuthUrl', operation);
    const clientId = required(profile.clientId, 'clientId', operation);
    const clientSecret = required(profile.clientSecret, 'clientSecret', operation);
    const saas = new URL(root).hostname.endsWith('.zeebe.camunda.io') ||
        new URL(oAuthUrl).hostname === 'login.cloud.camunda.io';
    const audience = Object.prototype.hasOwnProperty.call(profile, 'audience') || saas
        ? required(profile.audience, 'audience', operation) : undefined;
    return { restUrl, oauth: { oAuthUrl, clientId, clientSecret, audience } };
}

function required(value: string | undefined, field: string, operation: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Profile ${field} is required and must not be blank for ${operation}.`);
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
