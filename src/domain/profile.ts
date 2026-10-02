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
    requireNonblankString(input.name, 'name');
    requireNonblankString(input.baseUrl, 'baseUrl');

    const profile: Profile = { name: input.name.trim(), baseUrl: input.baseUrl };
    for (const field of optionalProfileFields) {
        const value = input[field];
        if (value !== undefined) {
            profile[field] = requireOptionalString(value);
        }
    }
    return profile;
}

function requireNonblankString(value: string, field: string): void {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Profile ${field} must be a non-whitespace string.`);
    }
}

function requireOptionalString(value: string): string {
    if (typeof value !== 'string') {
        throw new Error('Optional profile fields must be strings.');
    }
    return value;
}
