export interface DeployFilesCommand {
    path: string;
    profile: string;
    recursive?: boolean;
}

export interface DeployFilesInPort {
    deployFiles(command: DeployFilesCommand): Promise<void>;
}
