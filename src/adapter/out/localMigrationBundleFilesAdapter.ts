import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MigrationBundleFilesOutPort } from '../../application/ports/out/migrationBundleFilesOutPort';
import { safeDeploymentPath } from '../../domain/deployment';

export class LocalMigrationBundleFilesAdapter implements MigrationBundleFilesOutPort {
    async discover(sourceDir: string, target?: string): Promise<{ files: string[]; target: string }> {
        let source: string;
        try {
            const resolvedSource = path.resolve(sourceDir);
            if (!sourceDir.trim() || !(await lstat(resolvedSource)).isDirectory()) throw new Error();
            source = await realpath(resolvedSource);
        } catch {
            throw new Error('Cannot discover migration plans: sourceDir must be an existing readable non-symlink directory.');
        }
        let output: string;
        try {
            if (target !== undefined && !target.trim()) throw new Error();
            const resolved = target === undefined ? path.join(source, 'bundled-migrations.json') : path.resolve(target);
            output = path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
            await regularTarget(output);
        } catch {
            throw new Error('Cannot create migration bundle: target must be absent or a regular non-symlink file in an existing directory.');
        }
        const files: string[] = [];
        try {
            await this.scan(source, output, files);
        } catch {
            throw new Error(`Cannot discover migration plans in ${safeDeploymentPath(source)}: directory is missing or unreadable.`);
        }
        return { files: files.sort(), target: output };
    }

    private async scan(directory: string, target: string, files: string[]): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) await this.scan(filename, target, files);
            else if (entry.isFile() && path.extname(entry.name) === '.json' && filename !== target) files.push(filename);
        }
    }

    async write(target: string, contents: string): Promise<void> {
        const temporary = path.join(path.dirname(target), `.migration-bundle-${randomUUID()}.tmp`);
        let created = false;
        try {
            await regularTarget(target);
            const file = await open(temporary, 'wx', 0o600);
            created = true;
            try { await file.writeFile(contents, 'utf8'); } finally { await file.close(); }
            await regularTarget(target);
            await rename(temporary, target);
        } catch {
            throw new Error(`Cannot write migration bundle ${safeDeploymentPath(target)}: check target type and directory permissions.`);
        } finally {
            if (created) await unlink(temporary).catch(() => undefined);
        }
    }
}

async function regularTarget(target: string): Promise<void> {
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    });
    if (stat && !stat.isFile()) throw new Error();
}
