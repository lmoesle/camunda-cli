import { createDownloadFileName, ModelerFile } from '../../domain/modelerFile';
import {
    DownloadFileCommand,
    DownloadedFile,
    DownloadFilesCommand,
    DownloadFilesInPort,
} from '../ports/in/downloadFilesInPort';
import { ModelerFileOutPort } from '../ports/out/modelerFileOutPort';
import { WriteFileOutPort } from '../ports/out/writeFileOutPort';

export class DownloadFilesUseCase implements DownloadFilesInPort {
    constructor(
        private readonly modelerFileOutPort: ModelerFileOutPort,
        private readonly writeFileOutPort: WriteFileOutPort,
    ) {}

    async downloadFiles(command: DownloadFilesCommand): Promise<DownloadedFile[]> {
        const bearerToken = requireBearerToken(command.bearerToken);
        const modelerApiUrl = validateModelerApiUrl(command.modelerApiUrl);
        const metadata = await this.modelerFileOutPort.findAllFiles(bearerToken, modelerApiUrl);
        const fileNameCounts = countFileNames(metadata.map((file) => createDownloadFileName(file)));
        const downloadedFiles: DownloadedFile[] = [];
        const usedFileNames = new Set<string>();

        for (const fileMetadata of metadata) {
            const file = await this.modelerFileOutPort.getFile(bearerToken, fileMetadata.id, modelerApiUrl);
            const initialFileName = createDownloadFileName(fileMetadata);
            const duplicateName = (fileNameCounts.get(initialFileName.toLowerCase()) ?? 0) > 1;
            const fileName = chooseAvailableFileName(file, duplicateName, usedFileNames);
            const path = await this.writeFileOutPort.writeFile(command.destinationDirectory, fileName, file.content);

            downloadedFiles.push({ fileId: file.metadata.id, path });
        }

        return downloadedFiles;
    }

    async downloadFile(command: DownloadFileCommand): Promise<DownloadedFile> {
        const bearerToken = requireBearerToken(command.bearerToken);
        const modelerApiUrl = validateModelerApiUrl(command.modelerApiUrl);
        const fileId = requireIdentifier(command.fileId, 'file ID');
        const versionId = command.versionId === undefined
            ? undefined
            : requireIdentifier(command.versionId, 'version ID');
        const file = await this.modelerFileOutPort.getFile(bearerToken, fileId, modelerApiUrl);
        let content = file.content;

        if (versionId !== undefined) {
            const version = await this.modelerFileOutPort.getVersion(bearerToken, versionId, modelerApiUrl);

            if (version.metadata.fileId !== fileId) {
                throw new Error(`Version ${versionId} does not belong to file ${fileId}.`);
            }

            content = version.content;
        }

        const fileName = createDownloadFileName(file.metadata);
        const path = await this.writeFileOutPort.writeFile(command.destinationDirectory, fileName, content);

        return { fileId: file.metadata.id, path };
    }
}

function requireBearerToken(bearerToken: string): string {
    const token = bearerToken.trim();

    if (!token) {
        throw new Error('A bearer token is required.');
    }

    return token;
}

function requireIdentifier(identifier: string, description: string): string {
    const value = identifier.trim();

    if (!value) {
        throw new Error(`A ${description} is required.`);
    }

    return value;
}

function validateModelerApiUrl(modelerApiUrl: string | undefined): string | undefined {
    if (modelerApiUrl === undefined) {
        return undefined;
    }

    const value = modelerApiUrl.trim();

    try {
        const url = new URL(value);

        requireModelerApiBaseUrl(url, value);
        return url.toString().replace(/\/$/, '');
    } catch {
        throw new Error(`Invalid Modeler API URL: ${modelerApiUrl}`);
    }
}

function requireModelerApiBaseUrl(url: URL, value: string): void {
    if (!isHttpProtocol(url.protocol) || hasCredentials(url) || hasQueryOrFragment(value)) {
        throw new Error();
    }
}

function isHttpProtocol(protocol: string): boolean {
    return protocol === 'http:' || protocol === 'https:';
}

function hasCredentials(url: URL): boolean {
    return Boolean(url.username || url.password);
}

function hasQueryOrFragment(value: string): boolean {
    // URL.search and URL.hash are empty for a bare '?' or '#'; reject those too.
    return value.includes('?') || value.includes('#');
}

function countFileNames(fileNames: string[]): Map<string, number> {
    const counts = new Map<string, number>();

    for (const fileName of fileNames) {
        const normalizedName = fileName.toLowerCase();
        counts.set(normalizedName, (counts.get(normalizedName) ?? 0) + 1);
    }

    return counts;
}

function chooseAvailableFileName(file: ModelerFile, includeId: boolean, usedFileNames: Set<string>): string {
    let fileName = createDownloadFileName(file.metadata, includeId);
    let normalizedName = fileName.toLowerCase();

    if (usedFileNames.has(normalizedName)) {
        fileName = createDownloadFileName(file.metadata, true);
        normalizedName = fileName.toLowerCase();
    }

    if (usedFileNames.has(normalizedName)) {
        throw new Error(`Multiple Modeler files resolve to the same output file name: ${fileName}`);
    }

    usedFileNames.add(normalizedName);
    return fileName;
}
