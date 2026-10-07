import { runDefaultCamundaCli } from '../bootstrap/camundaCli';
import { MigrationBatchFailure } from '../domain/migration';

runDefaultCamundaCli().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    // Completed batches already printed their results; let piped output drain before exiting.
    if (error instanceof MigrationBatchFailure) {
        process.exitCode = 1;
        return;
    }
    console.error(error.message);
    process.exit(1);
});
