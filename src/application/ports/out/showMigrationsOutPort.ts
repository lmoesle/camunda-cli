import { MigrationPlanEntry } from '../../../domain/migration';

export interface ShowMigrationsOutPort {
    showMigrated(instanceKey: string, entry: MigrationPlanEntry): void;
    showSummary(count: number): void;
}
