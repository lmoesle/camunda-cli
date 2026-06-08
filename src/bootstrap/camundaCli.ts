import { Command } from 'commander';
import { createCamundaCli } from '../adapter/in/camundaCliAdapter';
import { ConsoleHelloWorldPresenter } from '../adapter/out/consoleHelloWorldPresenter';
import { HelloWorldUseCase } from '../application/usecases/helloWorldUseCase';

export interface CamundaCliBootstrapOptions {
    writeLine?: (line: string) => void;
    version?: string;
}

export function createDefaultCamundaCli(options: CamundaCliBootstrapOptions = {}): Command {
    const writeLine = options.writeLine ?? console.log;
    const showHelloWorldOutPort = new ConsoleHelloWorldPresenter(writeLine);
    const sayHelloWorldInPort = new HelloWorldUseCase(showHelloWorldOutPort);

    return createCamundaCli({
        sayHelloWorldInPort,
        version: options.version,
    });
}

export async function runDefaultCamundaCli(argv: string[] = process.argv): Promise<void> {
    await createDefaultCamundaCli().parseAsync(argv);
}
