import { OperateConnection } from '../../../domain/operateConnection';
import { MonitorDefinition, MonitorInstance } from '../../../domain/migrationMonitor';

export interface MigrationMonitorOutPort {
    discover(connection: OperateConnection): Promise<{ definitions: MonitorDefinition[]; instances: MonitorInstance[] }>;
}
