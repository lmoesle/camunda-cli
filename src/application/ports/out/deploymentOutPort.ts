import { DeploymentConnection, DeploymentResource } from '../../../domain/deployment';

export interface DeploymentSession {
    deploy(resource: DeploymentResource): Promise<string>;
}

export interface DeploymentOutPort {
    connect(connection: DeploymentConnection): Promise<DeploymentSession>;
}
