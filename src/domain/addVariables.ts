export function processInstanceKeys(input: string): string[] {
    let value: unknown;
    try { value = typeof input === 'string' ? JSON.parse(input) : undefined; }
    catch { throw new Error('Process instances must be a nonempty inline JSON array of string keys.'); }
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('Process instances must be a nonempty inline JSON array of string keys.');
    }
    const seen = new Set<string>();
    return value.map((item: unknown) => {
        const text = typeof item === 'string' ? item.trim() : '';
        if (!/^\d+$/.test(text) || BigInt(text) < 1n || BigInt(text) > 9223372036854775807n) {
            throw new Error('Each process instance key must be a positive base-10 signed-int64 string (1..9223372036854775807).');
        }
        const key = BigInt(text).toString();
        if (seen.has(key)) throw new Error('Process instance keys must not contain normalized duplicates.');
        seen.add(key);
        return key;
    });
}

// Only sanitized diagnostics may cross the adapter boundary.
export class AddVariablesFailure extends Error {}

export class AddVariablesBatchFailure extends Error {
    constructor(readonly successCount: number, readonly failedCount: number) {
        super(`Variable updates completed: ${successCount} succeeded, ${failedCount} failed.`);
    }
}
