import { runDefaultCamundaCli } from '../bootstrap/camundaCli';

runDefaultCamundaCli().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(error.message);
    process.exit(1);
});
