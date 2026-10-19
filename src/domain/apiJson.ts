import { LosslessNumber } from 'lossless-json';

// Node >=24 provides rawJSON; the project's ES2020 TypeScript library predates its types.
const nativeJson = JSON as typeof JSON & { rawJSON(value: string): unknown };

export function stringifyApiJson(value: unknown, space?: number): string | undefined {
    // lossless-json's serializer trusts a public isLosslessNumber property. Use
    // genuine parser-created instances only, preserving colliding JSON properties.
    return JSON.stringify(value, (_key, entry: unknown) => entry instanceof LosslessNumber
        ? nativeJson.rawJSON(entry.value) : entry, space);
}
