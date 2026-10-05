export interface ShowDeploymentsOutPort {
    showDeployed(filePath: string, deploymentKey: string): void;
    showSummary(count: number): void;
}
