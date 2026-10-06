import { deploymentConnection, safeDeploymentPath } from '../../domain/deployment';
import { DeployFilesCommand, DeployFilesInPort } from '../ports/in/deployFilesInPort';
import { DeploymentFilesOutPort } from '../ports/out/deploymentFilesOutPort';
import { DeploymentOutPort } from '../ports/out/deploymentOutPort';
import { DeploymentProfileOutPort } from '../ports/out/deploymentProfileOutPort';
import { ShowDeploymentsOutPort } from '../ports/out/showDeploymentsOutPort';

export class DeployFilesUseCase implements DeployFilesInPort {
    constructor(
        private readonly profiles: DeploymentProfileOutPort,
        private readonly files: DeploymentFilesOutPort,
        private readonly deployments: DeploymentOutPort,
        private readonly presenter: ShowDeploymentsOutPort,
    ) {}

    async deployFiles(command: DeployFilesCommand): Promise<void> {
        if (typeof command.profile !== 'string' || !command.profile.trim()) {
            throw new Error('The deploy command requires a nonblank profile name.');
        }
        const profile = this.profiles.getProfile(command.profile.trim());
        if (!profile) throw new Error('The selected profile does not exist. Add it with the add profile command.');
        const connection = deploymentConnection(profile);
        const paths = await this.files.discover(command.path, command.recursive ?? false);
        const session = await this.deployments.connect(connection);
        let count = 0;
        for (const filePath of paths) {
            let key: string;
            try {
                key = await session.deploy(await this.files.read(filePath));
            } catch (error) {
                const reason = error instanceof Error ? error.message : 'Deployment failed.';
                // eslint-disable-next-line preserve-caught-error -- Do not reattach adapter request configs or payloads to the public deployment error.
                throw new Error(`Failed to deploy ${safeDeploymentPath(filePath)} after ${count} successful deployment(s). ` +
                    `Prior successes remain committed; the failed request outcome may be uncertain. ${reason}`);
            }
            count++;
            this.presenter.showDeployed(filePath, key);
        }
        this.presenter.showSummary(count);
    }
}
