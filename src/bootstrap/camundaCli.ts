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
import { AxiosIncidentAdapter } from '../adapter/out/axiosIncidentAdapter';
import { ConsoleIncidentsPresenter } from '../adapter/out/consoleIncidentsPresenter';
import { ListIncidentsUseCase } from '../application/usecases/listIncidentsUseCase';

export interface CamundaCliBootstrapOptions {
    modelerApiBaseUrl?: string;
    writeLine?: (line: string) => void;
    writeDiagnostic?: (line: string) => void;
    version?: string;
    homeDirectory?: string;
}

export interface DefaultCamundaCli extends Command {
    initialize(): Promise<void>;
    readonly profiles: ProfileReadApi;
}

export function createDefaultCamundaCli(options: CamundaCliBootstrapOptions = {}): DefaultCamundaCli {
    return createRuntime(options, false).program;
}

function createRuntime(options: CamundaCliBootstrapOptions, deferNotices: boolean): {
    program: DefaultCamundaCli;
    flushNotices: () => void;
} {
    const writeLine = options.writeLine ?? console.log;
    const writeDiagnostic = options.writeDiagnostic ?? console.error;
    let incidentCommand = false;
    let deferred = deferNotices;
    const notices: string[] = [];
    const emitNotice = (line: string): void => {
        if (deferred) notices.push(line);
        else (incidentCommand ? writeDiagnostic : writeLine)(line);
    };
    const flushNotices = (): void => {
        deferred = false;
        for (const line of notices.splice(0)) emitNotice(line);
    };
    const showHelloWorldOutPort = new ConsoleHelloWorldPresenter(writeLine);
    const sayHelloWorldInPort = new HelloWorldUseCase(showHelloWorldOutPort);
    const modelerFileOutPort = new AxiosModelerFileAdapter(options.modelerApiBaseUrl);
    const writeFileOutPort = new LocalFileAdapter();
    const downloadFilesInPort = new DownloadFilesUseCase(modelerFileOutPort, writeFileOutPort);

    const repository = new JsonProfileRepositoryAdapter(options.homeDirectory);
    const cache = new ProfileCache();
    const loadProfilesInPort = new LoadProfilesUseCase(repository, cache, new ConsoleProfileNoticePresenter(emitNotice));
    let initialization: Promise<void> | undefined;
    const initialize = (): Promise<void> => initialization ??= loadProfilesInPort.loadProfiles();
    const program = createCamundaCli({
        downloadFilesInPort,
        sayHelloWorldInPort,
        addProfileInPort: new AddProfileUseCase(repository),
        listIncidentsInPort: new ListIncidentsUseCase(cache, new AxiosIncidentAdapter(), new ConsoleIncidentsPresenter(writeLine)),
        version: options.version,
    });
    // Commander identifies the command before required-option checks and preAction.
    // Route startup diagnostics explicitly, without inspecting global process.argv.
    program.hook('preSubcommand', (_parent, command) => {
        incidentCommand = command.name() === 'incidents';
        flushNotices();
    });
    if (deferNotices) {
        // Help/version may call process.exit before parseAsync returns. Flush root
        // notices before Commander writes those diagnostics, not in finally alone.
        const { writeOut, writeErr } = program.configureOutput();
        program.configureOutput({
            writeOut: (text) => { flushNotices(); writeOut!(text); },
            writeErr: (text) => { flushNotices(); writeErr!(text); },
        });
    }
    program.hook('preAction', initialize);
    // Expose only queries, not the cache's mutation methods, on the runtime.
    const runtime = Object.assign(program, {
        initialize,
        profiles: {
            getProfiles: () => cache.getProfiles(),
            getProfile: (name: string) => cache.getProfile(name),
        },
    });
    return { program: runtime, flushNotices };
}

export async function runDefaultCamundaCli(
    argv: string[] = process.argv,
    options: CamundaCliBootstrapOptions = {},
): Promise<void> {
    const { program, flushNotices } = createRuntime(options, true);
    await program.initialize();
    try {
        await program.parseAsync(argv);
    } finally {
        flushNotices();
    }
}
