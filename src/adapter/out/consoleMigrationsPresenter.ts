import { ShowMigrationsOutPort } from '../../application/ports/out/showMigrationsOutPort';
import { MigrationPlanEntry } from '../../domain/migration';
import { safeDeploymentPath } from '../../domain/deployment';

export class ConsoleMigrationsPresenter implements ShowMigrationsOutPort {
    constructor(private readonly writeLine: (line: string) => void = console.log,
        private readonly writeDiagnostic: (line: string) => void = console.error) {}
    showMigrated(instanceKey: string, entry: MigrationPlanEntry): void {
        this.writeLine(`Migrated instance ${safeDeploymentPath(instanceKey)}: ${safeDeploymentPath(entry.processDefinition)} v${entry.sourceVersion} -> v${entry.targetVersion}.`);
    }
    showFailed(message: string): void { this.writeDiagnostic(message); }
    showSummary(successfulCount: number, failedCount: number): void {
        this.writeLine(`Migrated ${successfulCount} process instance(s). ${failedCount} failed.`);
    }
}
