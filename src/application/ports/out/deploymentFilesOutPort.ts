import { DeploymentResource } from '../../../domain/deployment';

export interface DeploymentFilesOutPort {
    discover(inputPath: string, recursive: boolean): Promise<string[]>;
    read(filePath: string): Promise<DeploymentResource>;
}
