export function incidentRetryKey(value: string, field: 'incident' | 'job'): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!/^\d+$/.test(text)) throw new Error(`The ${field} key must be a positive base-10 signed-int64 identifier.`);
    const key = BigInt(text);
    if (key < 1n || key > 9223372036854775807n) {
        throw new Error(`The ${field} key must be between 1 and 9223372036854775807.`);
    }
    return key.toString();
}

// Only safe adapter diagnostics cross the application boundary on partial failure.
export class IncidentRetryFailure extends Error {}
