export interface DownloadFilesCommand {
    bearerToken: string;
    destinationDirectory: string;
    modelerApiUrl?: string;
}

export interface DownloadFileCommand extends DownloadFilesCommand {
    fileId: string;
    versionId?: string;
}

export interface DownloadedFile {
    fileId: string;
    path: string;
}

export interface DownloadFilesInPort {
    downloadFiles(command: DownloadFilesCommand): Promise<DownloadedFile[]>;
    downloadFile(command: DownloadFileCommand): Promise<DownloadedFile>;
}
