import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WriteFileOutPort } from '../../application/ports/out/writeFileOutPort';

export class LocalFileAdapter implements WriteFileOutPort {
    async writeFile(destinationDirectory: string, fileName: string, content: string): Promise<string> {
        const destinationPath = path.resolve(destinationDirectory);
        const filePath = path.resolve(destinationPath, fileName);

        if (path.dirname(filePath) !== destinationPath) {
            throw new Error(`Refusing to write outside the destination directory: ${fileName}`);
        }

        await mkdir(destinationPath, { recursive: true });
        await rejectSymbolicLink(filePath);

        const temporaryPath = path.join(destinationPath, `.camunda-cli-${randomUUID()}.tmp`);

        try {
            await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
            await rename(temporaryPath, filePath);
        } finally {
            await removeTemporaryFile(temporaryPath);
        }

        return filePath;
    }
}

async function rejectSymbolicLink(filePath: string): Promise<void> {
    try {
        const existingFile = await lstat(filePath);

        if (existingFile.isSymbolicLink()) {
            throw new Error(`Refusing to replace a symbolic link: ${filePath}`);
        }
    } catch (error: unknown) {
        if (!isFileSystemError(error, 'ENOENT')) {
            throw error;
        }
    }
}

async function removeTemporaryFile(temporaryPath: string): Promise<void> {
    try {
        await unlink(temporaryPath);
    } catch (error: unknown) {
        if (!isFileSystemError(error, 'ENOENT')) {
            throw error;
        }
    }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
