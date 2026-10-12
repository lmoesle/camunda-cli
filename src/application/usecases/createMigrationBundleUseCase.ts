import { CreateMigrationBundleCommand, CreateMigrationBundleInPort } from '../ports/in/createMigrationBundleInPort';
import { MigrationBundleFilesOutPort } from '../ports/out/migrationBundleFilesOutPort';
import { MigrationPlanFileOutPort } from '../ports/out/migrationPlanFileOutPort';
import { migrationPlan, MigrationPlanEntry } from '../../domain/migration';
import { safeDeploymentPath } from '../../domain/deployment';

export class CreateMigrationBundleUseCase implements CreateMigrationBundleInPort {
    constructor(private files: MigrationBundleFilesOutPort, private reader: MigrationPlanFileOutPort) {}

    async createMigrationBundle(command: CreateMigrationBundleCommand): Promise<void> {
        const { files, target } = await this.files.discover(command.sourceDir, command.target);
        if (!files.length) throw new Error('No input migration plan .json files found (excluding the bundle target).');
        const entries: MigrationPlanEntry[] = [];
        for (const file of files) {
            let contents: string;
            try { contents = await this.reader.read(file); } catch {
                throw new Error(`Cannot read migration plan file ${safeDeploymentPath(file)}: check that it is a readable regular non-symlink file.`);
            }
            try {
                for (const entry of migrationPlan(contents)) entries.push(entry);
            } catch (error) {
                // eslint-disable-next-line preserve-caught-error -- Domain parser diagnostics contain no input content.
                throw new Error(`Invalid migration plan file ${safeDeploymentPath(file)}: ${(error as Error).message}`);
            }
        }
        const bundle = migrationPlan(entries);
        await this.files.write(target, JSON.stringify(bundle, null, 2) + '\n');
    }
}
