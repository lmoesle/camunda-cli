import { MigrationPlanEntry } from '../../../domain/migration';

export interface ShowMigrationsOutPort {
    showMigrated(instanceKey: string, entry: MigrationPlanEntry): void;
    showFailed(message: string): void;
    showSummary(successfulCount: number, failedCount: number): void;
}
