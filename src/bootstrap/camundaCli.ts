import { Command } from 'commander';
import { createCamundaCli } from '../adapter/in/camundaCliAdapter';
import { AxiosModelerFileAdapter } from '../adapter/out/axiosModelerFileAdapter';
import { ConsoleHelloWorldPresenter } from '../adapter/out/consoleHelloWorldPresenter';
import { LocalFileAdapter } from '../adapter/out/localFileAdapter';
import { DownloadFilesUseCase } from '../application/usecases/downloadFilesUseCase';
import { HelloWorldUseCase } from '../application/usecases/helloWorldUseCase';

export interface CamundaCliBootstrapOptions {
    modelerApiBaseUrl?: string;
    writeLine?: (line: string) => void;
    version?: string;
}

export function createDefaultCamundaCli(options: CamundaCliBootstrapOptions = {}): Command {
    const writeLine = options.writeLine ?? console.log;
    const showHelloWorldOutPort = new ConsoleHelloWorldPresenter(writeLine);
    const sayHelloWorldInPort = new HelloWorldUseCase(showHelloWorldOutPort);
    const modelerFileOutPort = new AxiosModelerFileAdapter(options.modelerApiBaseUrl);
    const writeFileOutPort = new LocalFileAdapter();
    const downloadFilesInPort = new DownloadFilesUseCase(modelerFileOutPort, writeFileOutPort);

    return createCamundaCli({
        downloadFilesInPort,
        sayHelloWorldInPort,
        version: options.version,
    });
}

export async function runDefaultCamundaCli(argv: string[] = process.argv): Promise<void> {
    await createDefaultCamundaCli().parseAsync(argv);
}
