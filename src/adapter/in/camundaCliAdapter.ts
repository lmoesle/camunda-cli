import { Command, Option } from 'commander';
import { DownloadFilesInPort } from '../../application/ports/in/downloadFilesInPort';
import { SayHelloWorldInPort } from '../../application/ports/in/helloWorldInPort';
import { AddProfileCommand, AddProfileInPort } from '../../application/ports/in/addProfileInPort';
import { ListIncidentsCommand, ListIncidentsInPort } from '../../application/ports/in/listIncidentsInPort';
import { DeployFilesCommand, DeployFilesInPort } from '../../application/ports/in/deployFilesInPort';
import { MigrateProcessInstancesCommand, MigrateProcessInstancesInPort } from '../../application/ports/in/migrateProcessInstancesInPort';

declare const CAMUNDA_CLI_VERSION: string | undefined;

const cliVersion = typeof CAMUNDA_CLI_VERSION === 'string'
    ? CAMUNDA_CLI_VERSION
    : process.env.npm_package_version ?? '0.1.0';

export interface CamundaCliDependencies {
    downloadFilesInPort: DownloadFilesInPort;
    sayHelloWorldInPort: SayHelloWorldInPort;
    addProfileInPort?: AddProfileInPort;
    listIncidentsInPort?: ListIncidentsInPort;
    deployFilesInPort?: DeployFilesInPort;
    migrateProcessInstancesInPort?: MigrateProcessInstancesInPort;
    version?: string;
}

export function createCamundaCli(dependencies: CamundaCliDependencies): Command {
    const program = new Command();

    program
        .name('camunda-cli')
        .description('CLI for interacting with Camunda 8')
        .version(dependencies.version ?? cliVersion);

    program.command('migrate')
        .description('Migrate ACTIVE process instances using Camunda 8.7 deployment versions')
        .requiredOption('--profile <name>', 'stored profile name (required)')
        .requiredOption('--migrationPlan <json>', 'JSON array of migration plan entries (required)')
        .action(async (options: MigrateProcessInstancesCommand) => {
            if (!dependencies.migrateProcessInstancesInPort) throw new Error('The migrate command requires a MigrateProcessInstancesInPort dependency.');
            await dependencies.migrateProcessInstancesInPort.migrateProcessInstances(options);
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

    const downloadCommand = program
        .command('download')
        .description('Download files from Camunda 8 Web Modeler');

    downloadCommand
        .command('files')
        .description('Download the latest content of every Modeler file')
        .addOption(createBearerTokenOption())
        .addOption(createDestinationDirectoryOption())
        .addOption(createModelerApiUrlOption())
        .action(async (options: {
            bearerToken: string;
            destinationDirectory: string;
            modelerApiUrl?: string;
        }) => {
            await dependencies.downloadFilesInPort.downloadFiles({
                bearerToken: options.bearerToken,
                destinationDirectory: options.destinationDirectory,
                modelerApiUrl: options.modelerApiUrl,
            });
        });

    downloadCommand
        .command('file')
        .description('Download a single Modeler file')
        .argument('<file-id>', 'Modeler file ID')
        .addOption(createBearerTokenOption())
        .addOption(createDestinationDirectoryOption())
        .addOption(createModelerApiUrlOption())
        .option('--version-id <version-id>', 'specific Modeler file version ID')
        .action(async (fileId: string, options: {
            bearerToken: string;
            destinationDirectory: string;
            modelerApiUrl?: string;
            versionId?: string;
        }) => {
            await dependencies.downloadFilesInPort.downloadFile({
                bearerToken: options.bearerToken,
                destinationDirectory: options.destinationDirectory,
                fileId,
                modelerApiUrl: options.modelerApiUrl,
                versionId: options.versionId,
            });
        });

    program
        .command('hello-world')
        .description('Print a hello world message')
        .argument('[name]', 'name to greet', 'World')
        .action(async (name: string) => {
            await dependencies.sayHelloWorldInPort.sayHelloWorld({ name });
        });

    return program;
}

function createBearerTokenOption(): Option {
    return new Option('--bearer-token <token>', 'Camunda 8 Web Modeler JWT access token')
        .env('CAMUNDA_MODELER_BEARER_TOKEN')
        .makeOptionMandatory();
}

function createDestinationDirectoryOption(): Option {
    return new Option('-d, --destination-directory <path>', 'directory for downloaded files')
        .default(process.cwd());
}

function createModelerApiUrlOption(): Option {
    return new Option('--modeler-api-url <url>', 'custom Web Modeler API base URL for self-hosted Camunda 8');
}

export async function runCamundaCli(dependencies: CamundaCliDependencies, argv: string[] = process.argv): Promise<void> {
    await createCamundaCli(dependencies).parseAsync(argv);
}
