import { Command } from 'commander';
import { AddProfileCommand, AddProfileInPort } from '../../application/ports/in/addProfileInPort';
import { ListIncidentsCommand, ListIncidentsInPort } from '../../application/ports/in/listIncidentsInPort';
import { DeployFilesCommand, DeployFilesInPort } from '../../application/ports/in/deployFilesInPort';
import { MigrateProcessInstancesCommand, MigrateProcessInstancesInPort } from '../../application/ports/in/migrateProcessInstancesInPort';
import { RetryIncidentCommand, RetryIncidentInPort } from '../../application/ports/in/retryIncidentInPort';
import { CreateMigrationBundleCommand, CreateMigrationBundleInPort } from '../../application/ports/in/createMigrationBundleInPort';
import { OperateApiInPort } from '../../application/ports/in/operateApiInPort';
import { MigrationMonitorCommand, MigrationMonitorInPort } from '../../application/ports/in/migrationMonitorInPort';

declare const CAMUNDA_CLI_VERSION: string | undefined;

const cliVersion = typeof CAMUNDA_CLI_VERSION === 'string'
    ? CAMUNDA_CLI_VERSION
    : process.env.npm_package_version ?? '0.1.0';

export interface CamundaCliDependencies {
    addProfileInPort?: AddProfileInPort;
    listIncidentsInPort?: ListIncidentsInPort;
    deployFilesInPort?: DeployFilesInPort;
    migrateProcessInstancesInPort?: MigrateProcessInstancesInPort;
    retryIncidentInPort?: RetryIncidentInPort;
    createMigrationBundleInPort?: CreateMigrationBundleInPort;
    operateApiInPort?: OperateApiInPort;
    migrationMonitorInPort?: MigrationMonitorInPort;
    version?: string;
}

export function createCamundaCli(dependencies: CamundaCliDependencies): Command {
    const program = new Command();

    program
        .name('camunda-cli')
        .description('CLI for interacting with Camunda 8')
        .version(dependencies.version ?? cliVersion);

    program.command('api')
        .description('Call reviewed read-only Operate 8.7 operations; api ls lists supported operations offline')
        .argument('<usecase>', 'exact OpenAPI operationId, or ls')
        .argument('[request-json]', 'inline JSON object with path, query, and body sections')
        .option('--profile <name>', 'stored OAuth profile (required except for ls)')
        .addHelpText('after', '\nExamples:\n  api ls\n  api byKey_1 \'{"path":{"key":9007199254740993}}\' --profile local\n  api search_3 \'{"body":{"filter":{"state":"ACTIVE"}}}\' --profile local\n\nOnly read-only requests are supported, including POST searches. Request JSON cannot override endpoints or authentication. For write, change, or delete support, submit a feature request: https://github.com/lmoesle/camunda-cli/issues/new\n')
        .action(async (usecase: string, requestJson: string | undefined, options: { profile?: string }) => {
            if (!dependencies.operateApiInPort) throw new Error('The api command requires an OperateApiInPort dependency.');
            await dependencies.operateApiInPort.invokeApi({ usecase, requestJson, ...options });
        });

    program.command('migration-monitor')
        .description('Report ACTIVE instances on outdated deployed process versions (read-only, Camunda 8.7)')
        .requiredOption('--profile <name>', 'stored Operate OAuth profile name (required)')
        .option('--json', 'print a JSON array instead of a table')
        .action(async (options: MigrationMonitorCommand) => {
            if (!dependencies.migrationMonitorInPort) throw new Error('The migration-monitor command requires a MigrationMonitorInPort dependency.');
            await dependencies.migrationMonitorInPort.monitorMigration(options);
        });

    program.command('migrate')
        .description('Migrate ACTIVE process instances using Camunda 8.7 deployment versions')
        .requiredOption('--profile <name>', 'stored profile name (required)')
        .requiredOption('--migrationPlan <json-or-path>', 'JSON array of migration plan entries or path to a JSON file (required)')
        .action(async (options: MigrateProcessInstancesCommand) => {
            if (!dependencies.migrateProcessInstancesInPort) throw new Error('The migrate command requires a MigrateProcessInstancesInPort dependency.');
            await dependencies.migrateProcessInstancesInPort.migrateProcessInstances(options);
        });

    program.command('create-migration-bundle')
        .description('Combine local migration plan JSON files recursively into one validated array')
        .requiredOption('--sourceDir <directory>', 'directory containing migration plan JSON files (required)')
        .option('--target <file>', 'output file (default: sourceDir/bundled-migrations.json)')
        .action(async (options: CreateMigrationBundleCommand) => {
            if (!dependencies.createMigrationBundleInPort) throw new Error('The create-migration-bundle command requires a CreateMigrationBundleInPort dependency.');
            await dependencies.createMigrationBundleInPort.createMigrationBundle(options);
        });

    program.command('deploy')
        .description('Deploy each .bpmn, .dmn, or .form file independently to Camunda 8.7')
        .argument('<path>', 'file or directory to deploy')
        .requiredOption('--profile <name>', 'stored profile name (required)')
        .option('-r, --recursive', 'include subdirectories')
        .action(async (path: string, options: Omit<DeployFilesCommand, 'path'>) => {
            if (!dependencies.deployFilesInPort) throw new Error('The deploy command requires a DeployFilesInPort dependency.');
            await dependencies.deployFilesInPort.deployFiles({ ...options, path });
        });

    program.command('incident')
        .description('Manage Camunda 8.7 incidents')
        .command('retry')
        .description('Set job retries to 3, then request incident resolution')
        .requiredOption('--incident <incidentKey>', 'incident key (required)')
        .requiredOption('--job <jobKey>', 'failed job key (required)')
        .requiredOption('--profile <name>', 'stored profile name (required)')
        .action(async (options: RetryIncidentCommand) => {
            if (!dependencies.retryIncidentInPort) throw new Error('The incident retry command requires a RetryIncidentInPort dependency.');
            await dependencies.retryIncidentInPort.retryIncident(options);
        });

    program.command('incidents')
        .description('List all ACTIVE incidents through the Camunda 8.7 Operate API')
        .requiredOption('--profile <name>', 'stored profile name (required)')
        .option('--json', 'print a JSON array instead of a table')
        .action(async (options: ListIncidentsCommand) => {
            if (!dependencies.listIncidentsInPort) {
                throw new Error('The incidents command requires a ListIncidentsInPort dependency.');
            }
            await dependencies.listIncidentsInPort.listIncidents(options);
        });

    program.command('add')
        .description('Add stored configuration')
        .command('profile')
        .description('Store a named profile in ~/.lmoesle-camunda-cli/profiles.json (secrets are unencrypted)')
        .requiredOption('--name <name>', 'unique, case-sensitive profile name')
        .requiredOption('--base-url <url>', 'Camunda base URL')
        .option('--client-id <id>', 'OAuth client ID')
        .option('--client-secret <secret>', 'OAuth client secret (stored in cleartext)')
        .option('--audience <audience>', 'OAuth audience')
        .option('--operate-audience <audience>', 'Operate OAuth audience override')
        .option('--oauth-url <url>', 'OAuth URL')
        .option('--operate-url <url>', 'Operate URL')
        .option('--zeebe-url <url>', 'Zeebe URL')
        .action(async (options: Omit<AddProfileCommand, 'oAuthUrl'> & { oauthUrl?: string }) => {
            if (!dependencies.addProfileInPort) {
                throw new Error('The add profile command requires an AddProfileInPort dependency.');
            }
            const { oauthUrl, ...profile } = options;
            await dependencies.addProfileInPort.addProfile({ ...profile, oAuthUrl: oauthUrl });
        });

    return program;
}

export async function runCamundaCli(dependencies: CamundaCliDependencies, argv: string[] = process.argv): Promise<void> {
    await createCamundaCli(dependencies).parseAsync(argv);
}
