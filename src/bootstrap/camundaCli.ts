import { Command } from 'commander';
import { createCamundaCli } from '../adapter/in/camundaCliAdapter';
import { AxiosModelerFileAdapter } from '../adapter/out/axiosModelerFileAdapter';
import { ConsoleHelloWorldPresenter } from '../adapter/out/consoleHelloWorldPresenter';
import { LocalFileAdapter } from '../adapter/out/localFileAdapter';
import { DownloadFilesUseCase } from '../application/usecases/downloadFilesUseCase';
import { HelloWorldUseCase } from '../application/usecases/helloWorldUseCase';
import { AddProfileUseCase } from '../application/usecases/addProfileUseCase';
import { JsonProfileRepositoryAdapter } from '../adapter/out/jsonProfileRepositoryAdapter';
import { ConsoleProfileNoticePresenter } from '../adapter/out/consoleProfileNoticePresenter';
import { LoadProfilesUseCase } from '../application/usecases/loadProfilesUseCase';
import { ProfileCache, ProfileReadApi } from '../shared/profileCache';

export interface CamundaCliBootstrapOptions {
    modelerApiBaseUrl?: string;
    writeLine?: (line: string) => void;
    version?: string;
    homeDirectory?: string;
}

export interface DefaultCamundaCli extends Command {
    initialize(): Promise<void>;
    readonly profiles: ProfileReadApi;
}

export function createDefaultCamundaCli(options: CamundaCliBootstrapOptions = {}): DefaultCamundaCli {
    const writeLine = options.writeLine ?? console.log;
    const showHelloWorldOutPort = new ConsoleHelloWorldPresenter(writeLine);
    const sayHelloWorldInPort = new HelloWorldUseCase(showHelloWorldOutPort);
    const modelerFileOutPort = new AxiosModelerFileAdapter(options.modelerApiBaseUrl);
    const writeFileOutPort = new LocalFileAdapter();
    const downloadFilesInPort = new DownloadFilesUseCase(modelerFileOutPort, writeFileOutPort);

    const repository = new JsonProfileRepositoryAdapter(options.homeDirectory);
    const cache = new ProfileCache();
    const loadProfilesInPort = new LoadProfilesUseCase(repository, cache, new ConsoleProfileNoticePresenter(writeLine));
    let initialization: Promise<void> | undefined;
    const initialize = (): Promise<void> => initialization ??= loadProfilesInPort.loadProfiles();
    const program = createCamundaCli({
        downloadFilesInPort,
        sayHelloWorldInPort,
        addProfileInPort: new AddProfileUseCase(repository),
        version: options.version,
    });
    program.hook('preAction', initialize);
    // Expose only queries, not the cache's mutation methods, on the runtime.
    return Object.assign(program, {
        initialize,
        profiles: {
            getProfiles: () => cache.getProfiles(),
            getProfile: (name: string) => cache.getProfile(name),
        },
    });
}

export async function runDefaultCamundaCli(
    argv: string[] = process.argv,
    options: CamundaCliBootstrapOptions = {},
): Promise<void> {
    const program = createDefaultCamundaCli(options);
    await program.initialize();
    await program.parseAsync(argv);
}
