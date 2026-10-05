import { Profile } from './profile';

export interface DeploymentConnection {
    deploymentsUrl: string;
    oauth?: { oAuthUrl: string; clientId: string; clientSecret: string; audience?: string };
}

export interface DeploymentResource {
    filename: string;
    bytes: Uint8Array;
}

export function deploymentConnection(profile: Profile): DeploymentConnection {
    const root = endpoint(profile.baseUrl, 'baseUrl');
    const deploymentsUrl = `${root}${root.endsWith('/v2') ? '' : '/v2'}/deployments`;
    const fields = ['clientId', 'clientSecret', 'oAuthUrl', 'audience'] as const;
    if (!fields.some((field) => Object.prototype.hasOwnProperty.call(profile, field))) return { deploymentsUrl };
    const oAuthUrl = endpoint(profile.oAuthUrl, 'oAuthUrl');
    const clientId = required(profile.clientId, 'clientId');
    const clientSecret = required(profile.clientSecret, 'clientSecret');
    const saas = new URL(root).hostname.endsWith('.zeebe.camunda.io') ||
        new URL(oAuthUrl).hostname === 'login.cloud.camunda.io';
    const audience = Object.prototype.hasOwnProperty.call(profile, 'audience') || saas
        ? required(profile.audience, 'audience') : undefined;
    return { deploymentsUrl, oauth: { oAuthUrl, clientId, clientSecret, audience } };
}

function required(value: string | undefined, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Profile ${field} is required and must not be blank for deploy.`);
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

export function safeDeploymentPath(value: string): string {
    // eslint-disable-next-line no-control-regex -- escape controls at the terminal boundary
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
