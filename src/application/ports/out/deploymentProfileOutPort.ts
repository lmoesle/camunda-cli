import { Profile } from '../../../domain/profile';

export interface DeploymentProfileOutPort {
    getProfile(name: string): Profile | undefined;
}
