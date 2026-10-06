export interface MigrateProcessInstancesCommand { profile: string; migrationPlan: unknown }
export interface MigrateProcessInstancesInPort {
    migrateProcessInstances(command: MigrateProcessInstancesCommand): Promise<void>;
}
