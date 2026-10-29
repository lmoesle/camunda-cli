export interface MigrationMonitorCommand { profile: string }

export interface MigrationMonitorInPort {
    monitorMigration(command: MigrationMonitorCommand): Promise<void>;
}
