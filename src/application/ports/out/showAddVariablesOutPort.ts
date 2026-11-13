export interface ShowAddVariablesOutPort {
    showUpdated(processInstanceKey: string): void;
    showFailed(message: string): void;
    showSummary(successCount: number, failedCount: number): void;
}
