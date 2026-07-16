import { ModelerFile, ModelerFileMetadata, ModelerVersion } from '../../../domain/modelerFile';

export interface ModelerFileOutPort {
    findAllFiles(bearerToken: string, modelerApiUrl?: string): Promise<ModelerFileMetadata[]>;
    getFile(bearerToken: string, fileId: string, modelerApiUrl?: string): Promise<ModelerFile>;
    getVersion(bearerToken: string, versionId: string, modelerApiUrl?: string): Promise<ModelerVersion>;
}
