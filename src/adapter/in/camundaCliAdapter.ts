import { Command } from 'commander';
import { SayHelloWorldInPort } from '../../application/ports/in/helloWorldInPort';

declare const CAMUNDA_CLI_VERSION: string | undefined;

const cliVersion = typeof CAMUNDA_CLI_VERSION === 'string'
    ? CAMUNDA_CLI_VERSION
    : process.env.npm_package_version ?? '0.1.0';

export interface CamundaCliDependencies {
    sayHelloWorldInPort: SayHelloWorldInPort;
    version?: string;
}

export function createCamundaCli(dependencies: CamundaCliDependencies): Command {
    const program = new Command();

    program
        .name('camunda-cli')
        .description('CLI for interacting with the Camunda 7 REST API')
        .version(dependencies.version ?? cliVersion);

    program
        .command('hello-world')
        .description('Print a hello world message')
        .argument('[name]', 'name to greet', 'World')
        .action(async (name: string) => {
            await dependencies.sayHelloWorldInPort.sayHelloWorld({ name });
        });

    return program;
}

export async function runCamundaCli(dependencies: CamundaCliDependencies, argv: string[] = process.argv): Promise<void> {
    await createCamundaCli(dependencies).parseAsync(argv);
}
