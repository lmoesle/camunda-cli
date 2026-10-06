import { Profile } from './profile';
import { restConnection } from './restConnection';

export interface DeploymentConnection {
    deploymentsUrl: string;
    oauth?: { oAuthUrl: string; clientId: string; clientSecret: string; audience?: string };
}

export interface DeploymentResource {
    filename: string;
    bytes: Uint8Array;
}

export function deploymentConnection(profile: Profile): DeploymentConnection {
    const { restUrl, oauth } = restConnection(profile, 'deploy');
    return oauth ? { deploymentsUrl: `${restUrl}/deployments`, oauth } : { deploymentsUrl: `${restUrl}/deployments` };
}

export function safeDeploymentPath(value: string): string {
    // eslint-disable-next-line no-control-regex -- escape controls at the terminal boundary
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
