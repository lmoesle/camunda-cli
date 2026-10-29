export interface MonitorDefinition {
    key: string;
    bpmnProcessId: string;
    version: number;
    name?: string;
    tenantId?: string;
}

export interface MonitorInstance {
    key: string;
    processDefinitionKey: string;
    bpmnProcessId: string;
    processVersion: number;
    tenantId?: string;
}

export interface MigrationMonitorRow {
    processName: string;
    bpmnProcessId: string;
    tenantId?: string;
    latestVersion: number;
    activeInstances: number;
    outdatedVersions: { version: number; activeInstances: number }[];
}

export function inconsistentMonitorData(): Error {
    return new Error('Operate migration monitor discovery returned inconsistent or malformed data. Indexing may still be in progress; retry the report.');
}

export function migrationMonitorReport(definitions: MonitorDefinition[], instances: MonitorInstance[]): MigrationMonitorRow[] {
    const byKey = new Map<string, MonitorDefinition>();
    const versions = new Set<string>();
    const groups = new Map<string, { latest: MonitorDefinition; counts: Map<number, number> }>();
    const identity = (item: { tenantId?: string; bpmnProcessId: string }): string => JSON.stringify([item.tenantId ?? null, item.bpmnProcessId]);
    for (const definition of definitions) {
        if (byKey.has(definition.key)) throw inconsistentMonitorData();
        byKey.set(definition.key, definition);
        const id = identity(definition);
        const versionId = JSON.stringify([id, definition.version]);
        if (versions.has(versionId)) throw inconsistentMonitorData();
        versions.add(versionId);
        const group = groups.get(id);
        if (!group) groups.set(id, { latest: definition, counts: new Map() });
        else if (definition.version > group.latest.version) group.latest = definition;
        else if (definition.version === group.latest.version) throw inconsistentMonitorData();
    }
    const seen = new Set<string>();
    for (const instance of instances) {
        const definition = byKey.get(instance.processDefinitionKey);
        if (seen.has(instance.key) || !definition || identity(instance) !== identity(definition) || instance.processVersion !== definition.version) {
            throw inconsistentMonitorData();
        }
        seen.add(instance.key);
        const group = groups.get(identity(definition))!;
        group.counts.set(definition.version, (group.counts.get(definition.version) ?? 0) + 1);
    }
    const rows: MigrationMonitorRow[] = [];
    for (const { latest, counts } of groups.values()) {
        const outdatedVersions = [...counts].filter(([version]) => version < latest.version)
            .sort(([a], [b]) => a - b).map(([version, activeInstances]) => ({ version, activeInstances }));
        if (!outdatedVersions.length) continue;
        rows.push({ processName: latest.name?.trim() ? latest.name : latest.bpmnProcessId, bpmnProcessId: latest.bpmnProcessId,
            tenantId: latest.tenantId, latestVersion: latest.version,
            activeInstances: [...counts.values()].reduce((sum, count) => sum + count, 0), outdatedVersions });
    }
    const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
    return rows.sort((a, b) => compare(a.tenantId ?? '', b.tenantId ?? '') || compare(a.bpmnProcessId, b.bpmnProcessId) ||
        compare(JSON.stringify(a.tenantId ?? null), JSON.stringify(b.tenantId ?? null)));
}
