import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { MigrationPlanFileOutPort } from '../../application/ports/out/migrationPlanFileOutPort';

export class LocalMigrationPlanFileAdapter implements MigrationPlanFileOutPort {
    async read(filePath: string): Promise<string> {
        try {
            if (!(await lstat(filePath)).isFile()) throw new Error();
            const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                if (!(await file.stat()).isFile()) throw new Error();
                return await file.readFile('utf8');
            } finally { await file.close(); }
        } catch {
            throw new Error('Cannot read migration plan file. Check that the path points to a readable regular non-symlink file; relative paths use the current working directory.');
        }
    }
}
