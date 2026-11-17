export interface UserTask {
    key: string;
    processInstanceKey: string;
    elementId: string;
    assignee?: string | null;
    state: 'CREATED';
    creationDate: string;
}

export class UserTaskFailure extends Error {}

export function userTaskKey(value: string): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!/^\d+$/.test(text) || BigInt(text) < 1n || BigInt(text) > 9223372036854775807n) {
        throw new Error('User task and process instance keys must be positive decimal signed-int64 strings.');
    }
    return BigInt(text).toString();
}

export function userTaskFilter(filter?: string[]): string | undefined {
    if (filter === undefined) return undefined;
    if (filter.length !== 2 || filter[0] !== 'process-instance') {
        throw new Error('Use --filter process-instance <key> exactly once, or omit the filter.');
    }
    return userTaskKey(filter[1]);
}
