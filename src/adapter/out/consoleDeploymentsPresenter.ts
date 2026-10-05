import { ShowDeploymentsOutPort } from '../../application/ports/out/showDeploymentsOutPort';
import { safeDeploymentPath } from '../../domain/deployment';

export class ConsoleDeploymentsPresenter implements ShowDeploymentsOutPort {
    constructor(private readonly writeLine: (line: string) => void = console.log) {}

    showDeployed(filePath: string, deploymentKey: string): void {
        this.writeLine(`Deployed ${safeDeploymentPath(filePath)} (deployment key ${deploymentKey}).`);
    }

    showSummary(count: number): void {
        this.writeLine(`Successfully deployed ${count} file(s)`);
    }
}
