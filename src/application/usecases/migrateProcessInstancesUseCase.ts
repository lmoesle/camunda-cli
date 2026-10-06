import { MigrationBatchFailure, migrationConnection, MigrationDefinition, migrationPlan, MissingMigrationElement } from '../../domain/migration';
import { MigrateProcessInstancesCommand, MigrateProcessInstancesInPort } from '../ports/in/migrateProcessInstancesInPort';
import { MigrationOutPort } from '../ports/out/migrationOutPort';
import { MigrationProfileOutPort } from '../ports/out/migrationProfileOutPort';
import { MigrationPlanFileOutPort } from '../ports/out/migrationPlanFileOutPort';
import { ShowMigrationsOutPort } from '../ports/out/showMigrationsOutPort';

export class MigrateProcessInstancesUseCase implements MigrateProcessInstancesInPort {
    constructor(private readonly profiles: MigrationProfileOutPort, private readonly migration: MigrationOutPort,
        private readonly presenter: ShowMigrationsOutPort, private readonly planFiles?: MigrationPlanFileOutPort) {}

    async migrateProcessInstances(command: MigrateProcessInstancesCommand): Promise<void> {
        const input = command.migrationPlan;
        const plan = migrationPlan(this.planFiles && typeof input === 'string' && !isInlineJson(input)
            ? await this.planFiles.read(input) : input);
        if (typeof command.profile !== 'string' || !command.profile.trim()) throw new Error('Migrate requires a nonblank profile name.');
        const profile = this.profiles.getProfile(command.profile.trim());
        if (!profile) throw new Error('The selected profile does not exist. Add it with the add profile command.');
        const session = await this.migration.connect(migrationConnection(profile));
        const seen = new Set<string>();
        const snapshots = [];
        for (const [index, entry] of plan.entries()) {
            const resolve = async (version: number): Promise<MigrationDefinition> => {
                const definitions = await session.searchDefinitions(entry.processDefinition, version);
                if (definitions.length !== 1) throw new Error(`Migration plan entry ${index}: definition version ${version} matched ${definitions.length} results; require exactly one across visible tenants.`);
                const definition = definitions[0];
                if (definition.bpmnProcessId !== entry.processDefinition || definition.version !== version) {
                    throw new Error(`Migration plan entry ${index}: discovery returned a mismatched definition.`);
                }
                return definition;
            };
            const source = await resolve(entry.sourceVersion);
            const target = await resolve(entry.targetVersion);
            if (source.key === target.key || source.tenantId !== target.tenantId) {
                throw new Error(`Migration plan entry ${index}: source and target must have different keys and matching tenants.`);
            }
            const instances = await session.searchActiveInstances(source);
            for (const instance of instances) {
                if (instance.state !== 'ACTIVE' || instance.processDefinitionKey !== source.key || instance.tenantId !== source.tenantId || seen.has(instance.key)) {
                    throw new Error(`Migration plan entry ${index}: discovery returned an invalid or duplicate instance candidate.`);
                }
                seen.add(instance.key);
            }
            instances.sort((a, b) => BigInt(a.key) < BigInt(b.key) ? -1 : BigInt(a.key) > BigInt(b.key) ? 1 : 0);
            snapshots.push({ entry, target, instances });
        }
        let count = 0;
        let failedCount = 0;
        for (const { entry, target, instances } of snapshots) {
            for (const instance of instances) {
                try { await session.migrate(instance.key, target.key, entry.mappingInstructions); } catch (error) {
                    const status = error instanceof MissingMigrationElement ? `HTTP ${error.status}`
                        : error instanceof Error ? error.message.match(/HTTP \d{3}/)?.[0] : undefined;
                    const diagnostic = error instanceof MissingMigrationElement ? error.diagnostic(entry) : undefined;
                    failedCount++;
                    this.presenter.showFailed(`Migration failed for instance ${instance.key} after ${count} successful migrations${status ? ` (${status})` : ''}. ${diagnostic ? diagnostic + ' ' : ''}Prior successes remain committed; the failed request outcome may be uncertain. No retry or rollback was attempted.`);
                    continue;
                }
                count++;
                this.presenter.showMigrated(instance.key, entry);
            }
        }
        this.presenter.showSummary(count, failedCount);
        // Report the completed batch before rejecting, so callers can detect failure without duplicate CLI output.
        if (failedCount > 0) throw new MigrationBatchFailure(count, failedCount);
    }
}

function isInlineJson(input: string): boolean {
    // Keep malformed array/object input and blanks on the domain's JSON diagnostic path.
    const trimmed = input.trim();
    if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith('{')) return true;
    try { JSON.parse(input); return true; } catch { return false; }
}
