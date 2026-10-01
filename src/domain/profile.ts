export interface Profile {
    name: string;
    baseUrl: string;
    clientId?: string;
    clientSecret?: string;
    audience?: string;
    oAuthUrl?: string;
    operateUrl?: string;
    zeebeUrl?: string;
}

export const optionalProfileFields = ['clientId', 'clientSecret', 'audience', 'oAuthUrl', 'operateUrl', 'zeebeUrl'] as const;

export function createProfile(input: Profile): Profile {
    if (typeof input.name !== 'string' || !input.name.trim()) {
        throw new Error('Profile name must be a non-whitespace string.');
    }
    if (typeof input.baseUrl !== 'string' || !input.baseUrl.trim()) {
        throw new Error('Profile baseUrl must be a non-whitespace string.');
    }

    const profile: Profile = { name: input.name.trim(), baseUrl: input.baseUrl };
    for (const field of optionalProfileFields) {
        const value = input[field];
        if (value !== undefined) {
            if (typeof value !== 'string') {
                throw new Error('Optional profile fields must be strings.');
            }
            profile[field] = value;
        }
    }
    return profile;
}
