import { MigrationMonitorRow } from '../../../domain/migrationMonitor';

export interface ShowMigrationMonitorOutPort {
    showMigrationMonitor(rows: MigrationMonitorRow[]): void;
}
