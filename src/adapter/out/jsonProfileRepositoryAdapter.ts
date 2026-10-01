import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ProfileRepositoryOutPort } from '../../application/ports/out/profileRepositoryOutPort';
import { LoadProfilesOutPort } from '../../application/ports/out/loadProfilesOutPort';
import { createProfile, optionalProfileFields, Profile } from '../../domain/profile';

class ProfileStorageError extends Error {}

interface ProfileDocument {
    profiles: Profile[];
    [key: string]: unknown;
}

export class JsonProfileRepositoryAdapter implements ProfileRepositoryOutPort, LoadProfilesOutPort {
    private directory: string;
    private filePath: string;

    constructor(homeDirectory: string = homedir()) {
        this.directory = path.join(homeDirectory, '.lmoesle-camunda-cli');
        this.filePath = path.join(this.directory, 'profiles.json');
    }

    async listProfiles(): Promise<Profile[]> {
        return (await this.loadProfiles()) ?? [];
    }

    async loadProfiles(): Promise<Profile[] | undefined> {
        return this.withSafeErrors(async () => {
            await this.checkDirectory();
            return (await this.readDocument())?.profiles;
        });
    }

    async addProfile(input: Profile): Promise<void> {
        const profile = createProfile(input);
        await this.withSafeErrors(async () => {
            await this.checkDirectory();
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            await this.checkDirectory();
            await chmod(this.directory, 0o700);

            // An exclusive lock prevents cooperating CLI processes from losing updates.
            // Never remove a lock owned by another process; the caller can retry.
            const lockPath = path.join(this.directory, 'profiles.lock');
            const lock = await open(lockPath, 'wx', 0o600).catch((error: unknown) => {
                if (hasCode(error, 'EEXIST')) {
                    throw new ProfileStorageError('Profile storage is locked by another add operation. Retry later.');
                }
                throw error;
            });
            const temporaryPath = path.join(this.directory, `.profiles-${randomUUID()}.tmp`);
            try {
                const document = (await this.readDocument()) ?? { profiles: [] };
                if (document.profiles.some((existing) => existing.name.trim() === profile.name)) {
                    throw new ProfileStorageError('A profile with this name already exists.');
                }
                document.profiles.push(profile);
                await writeFile(temporaryPath, `${JSON.stringify(document, null, 4)}\n`, {
                    encoding: 'utf8', flag: 'wx', mode: 0o600,
                });
                await this.checkDirectory();
                await this.checkFile();
                await rename(temporaryPath, this.filePath);
            } finally {
                try {
                    await removeIfPresent(temporaryPath);
                } finally {
                    await lock.close();
                    await unlink(lockPath);
                }
            }
        });
    }

    private async checkDirectory(): Promise<void> {
        try {
            const stat = await lstat(this.directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new ProfileStorageError('Profile configuration directory must be a real directory, not a symbolic link.');
            }
        } catch (error: unknown) {
            if (!hasCode(error, 'ENOENT')) {
                throw error;
            }
        }
    }

    private async checkFile(): Promise<void> {
        try {
            const stat = await lstat(this.filePath);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new ProfileStorageError('Profile storage must be a regular file, not a symbolic link.');
            }
        } catch (error: unknown) {
            if (!hasCode(error, 'ENOENT')) {
                throw error;
            }
        }
    }

    private async readDocument(): Promise<ProfileDocument | undefined> {
        await this.checkFile();
        let content: string;
        try {
            const file = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                if (!(await file.stat()).isFile()) {
                    throw new ProfileStorageError('Profile storage must be a regular file.');
                }
                content = await file.readFile('utf8');
            } finally {
                await file.close();
            }
        } catch (error: unknown) {
            if (hasCode(error, 'ENOENT')) {
                return undefined;
            }
            throw error;
        }

        try {
            const document: unknown = JSON.parse(content);
            if (!isRecord(document) || !Array.isArray(document.profiles)) {
                throw new Error();
            }
            const names = new Set<string>();
            for (const profile of document.profiles) {
                if (!isRecord(profile) || typeof profile.name !== 'string' || !profile.name.trim()
                    || typeof profile.baseUrl !== 'string' || !profile.baseUrl.trim()
                    || optionalProfileFields.some((field) => field in profile && typeof profile[field] !== 'string')
                    || names.has(profile.name.trim())) {
                    throw new Error();
                }
                names.add(profile.name.trim());
            }
            // Keep unknown keys and existing values intact for forward compatibility.
            return document as unknown as ProfileDocument;
        } catch {
            throw new ProfileStorageError('Profile storage contains invalid JSON or an invalid profile schema.');
        }
    }

    private async withSafeErrors<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error: unknown) {
            if (error instanceof ProfileStorageError) {
                throw error;
            }
            throw new Error('Unable to access profile storage. Check permissions and available disk space.');
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function removeIfPresent(filePath: string): Promise<void> {
    try {
        await unlink(filePath);
    } catch (error: unknown) {
        if (!hasCode(error, 'ENOENT')) {
            throw error;
        }
    }
}
