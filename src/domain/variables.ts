import { LosslessNumber, parse } from 'lossless-json';

export function parseVariables(input: string): Record<string, unknown> {
    let value: unknown;
    try { value = typeof input === 'string' ? parse(input) : undefined; }
    catch { throw new Error('Variables must be an inline JSON object.'); }
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) {
        throw new Error('Variables must be an inline JSON object.');
    }
    return value as Record<string, unknown>;
}
