import { ShowMigrationsOutPort } from '../../application/ports/out/showMigrationsOutPort';
import { MigrationPlanEntry } from '../../domain/migration';
import { safeDeploymentPath } from '../../domain/deployment';

export class ConsoleMigrationsPresenter implements ShowMigrationsOutPort {
    constructor(private readonly writeLine: (line: string) => void = console.log) {}
    showMigrated(instanceKey: string, entry: MigrationPlanEntry): void {
        this.writeLine(`Migrated instance ${safeDeploymentPath(instanceKey)}: ${safeDeploymentPath(entry.processDefinition)} v${entry.sourceVersion} -> v${entry.targetVersion}.`);
    }
    showSummary(count: number): void { this.writeLine(`Migrated ${count} process instance(s).`); }
}
