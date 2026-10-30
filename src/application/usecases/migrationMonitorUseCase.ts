import { MigrationMonitorCommand, MigrationMonitorInPort } from '../ports/in/migrationMonitorInPort';
import { MigrationMonitorOutPort } from '../ports/out/migrationMonitorOutPort';
import { MigrationMonitorProfileOutPort } from '../ports/out/migrationMonitorProfileOutPort';
import { ShowMigrationMonitorOutPort } from '../ports/out/showMigrationMonitorOutPort';
import { operateConnection } from '../../domain/operateConnection';
import { migrationMonitorReport } from '../../domain/migrationMonitor';

export class MigrationMonitorUseCase implements MigrationMonitorInPort {
    constructor(private readonly profiles: MigrationMonitorProfileOutPort,
        private readonly discovery: MigrationMonitorOutPort, private readonly presenter: ShowMigrationMonitorOutPort) {}

    async monitorMigration(command: MigrationMonitorCommand): Promise<void> {
        if (typeof command.profile !== 'string' || !command.profile.trim()) {
            throw new Error('The migration-monitor command requires a nonblank profile name.');
        }
        const profile = this.profiles.getProfile(command.profile.trim());
        if (!profile) throw new Error('The selected profile does not exist. Add it with the add profile command.');
        const { definitions, instances } = await this.discovery.discover(operateConnection(profile, 'migration-monitor'));
        this.presenter.showMigrationMonitor(migrationMonitorReport(definitions, instances), command.json ?? false);
    }
}
