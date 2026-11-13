import { ShowAddVariablesOutPort } from '../../application/ports/out/showAddVariablesOutPort';

export class ConsoleAddVariablesPresenter implements ShowAddVariablesOutPort {
    constructor(private readonly writeLine: (line: string) => void = console.log,
        private readonly writeDiagnostic: (line: string) => void = console.error) {}

    showUpdated(key: string): void { this.writeLine(`Updated variables for process instance ${key}.`); }
    showFailed(message: string): void { this.writeDiagnostic(message); }
    showSummary(successCount: number, failedCount: number): void {
        this.writeLine(`Variable updates completed: ${successCount} succeeded, ${failedCount} failed.`);
    }
}
