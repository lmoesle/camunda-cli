import { MigrationConnection, MigrationDefinition, MigrationInstance, MigrationPlanEntry } from '../../../domain/migration';

export interface MigrationSession {
    searchDefinitions(processDefinition: string, version: number): Promise<MigrationDefinition[]>;
    searchActiveInstances(source: MigrationDefinition): Promise<MigrationInstance[]>;
    migrate(instanceKey: string, targetKey: string, mappings: MigrationPlanEntry['mappingInstructions']): Promise<void>;
}
export interface MigrationOutPort { connect(connection: MigrationConnection): Promise<MigrationSession> }
