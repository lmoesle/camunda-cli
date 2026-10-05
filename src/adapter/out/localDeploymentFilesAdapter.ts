import { constants } from 'node:fs';
import { access, lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DeploymentFilesOutPort } from '../../application/ports/out/deploymentFilesOutPort';
import { DeploymentResource, safeDeploymentPath } from '../../domain/deployment';

export class LocalDeploymentFilesAdapter implements DeploymentFilesOutPort {
    async discover(inputPath: string, recursive: boolean): Promise<string[]> {
        const files: string[] = [];
        try {
            const stat = await lstat(inputPath);
            if (stat.isFile()) {
                if (!supported(inputPath)) throw new Error('Unsupported file extension; use .bpmn, .dmn, or .form.');
                await access(inputPath, constants.R_OK);
                files.push(inputPath);
            } else if (stat.isDirectory()) {
                await this.scan(inputPath, recursive, files);
            } else {
                throw new Error('Input must be a regular file or directory, not a symlink or special file.');
            }
        } catch (error) {
            const reason = error instanceof Error && !('code' in error) ? error.message : 'Input is missing or unreadable.';
            throw new Error(`Cannot discover ${safeDeploymentPath(inputPath)}. ${reason}`);
        }
        if (files.length === 0) throw new Error(`No supported regular files found in ${safeDeploymentPath(inputPath)}.`);
        return files.sort();
    }

    private async scan(directory: string, recursive: boolean, files: string[]): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const filePath = path.join(directory, entry.name);
            if (entry.isFile() && supported(entry.name)) {
                await access(filePath, constants.R_OK);
                files.push(filePath);
            } else if (recursive && entry.isDirectory()) {
                await this.scan(filePath, recursive, files);
            }
        }
    }

    async read(filePath: string): Promise<DeploymentResource> {
        try {
            if (!(await lstat(filePath)).isFile()) throw new Error();
            const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                if (!(await file.stat()).isFile()) throw new Error();
                return { filename: path.basename(filePath), bytes: await file.readFile() };
            } finally { await file.close(); }
        } catch {
            throw new Error(`Cannot read regular non-symlink file ${safeDeploymentPath(filePath)}; it may be missing or unreadable.`);
        }
    }
}

function supported(filename: string): boolean {
    return ['.bpmn', '.dmn', '.form'].includes(path.extname(filename));
}
