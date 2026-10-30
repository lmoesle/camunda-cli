export interface MigrationMonitorCommand { profile: string; json?: boolean }

export interface MigrationMonitorInPort {
    monitorMigration(command: MigrationMonitorCommand): Promise<void>;
}
