import { ShowMigrationMonitorOutPort } from '../../application/ports/out/showMigrationMonitorOutPort';
import { MigrationMonitorRow } from '../../domain/migrationMonitor';

export class ConsoleMigrationMonitorPresenter implements ShowMigrationMonitorOutPort {
    constructor(private readonly writeLine: (line: string) => void = console.log) {}

    showMigrationMonitor(report: MigrationMonitorRow[]): void {
        const activeInstances = report.reduce((sum, row) => sum + row.activeInstances, 0);
        const outdatedInstances = report.reduce((sum, row) => sum + row.outdatedVersions.reduce((count, entry) => count + entry.activeInstances, 0), 0);
        const summary = `Total (displayed processes): Active instances: ${activeInstances} | Number of outdated instances: ${outdatedInstances}`;
        if (!report.length) {
            this.writeLine(`No active process instances on outdated versions found.\n${summary}`);
            return;
        }
        const tenants = report.some((row) => row.tenantId !== undefined);
        const rows = [
            [...(tenants ? ['Tenant'] : []), 'Process name', 'Process definition id', 'Latest version', 'Active instances', 'Number of outdated instances'],
            ...report.map((row) => [...(tenants ? [row.tenantId ?? '(unspecified)'] : []), row.processName, row.bpmnProcessId,
                String(row.latestVersion), String(row.activeInstances),
                String(row.outdatedVersions.reduce((sum, entry) => sum + entry.activeInstances, 0))].map(safeCell)),
        ];
        const widths = rows.reduce((widths, row) => row.map((cell, column) => Math.max(widths[column], cell.length)), rows[0].map(() => 0));
        this.writeLine(`${rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join(' | ').trimEnd()).join('\n')}\n${summary}`);
    }
}

function safeCell(value: string): string {
    // eslint-disable-next-line no-control-regex -- terminal-safety boundary
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
