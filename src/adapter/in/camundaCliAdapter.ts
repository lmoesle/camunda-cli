import { Command, Option } from 'commander';
import { DownloadFilesInPort } from '../../application/ports/in/downloadFilesInPort';
import { SayHelloWorldInPort } from '../../application/ports/in/helloWorldInPort';

declare const CAMUNDA_CLI_VERSION: string | undefined;

const cliVersion = typeof CAMUNDA_CLI_VERSION === 'string'
    ? CAMUNDA_CLI_VERSION
    : process.env.npm_package_version ?? '0.1.0';

export interface CamundaCliDependencies {
    downloadFilesInPort: DownloadFilesInPort;
    sayHelloWorldInPort: SayHelloWorldInPort;
    version?: string;
}

export function createCamundaCli(dependencies: CamundaCliDependencies): Command {
    const program = new Command();

    program
        .name('camunda-cli')
        .description('CLI for interacting with Camunda 8')
        .version(dependencies.version ?? cliVersion);

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
