import { Profile } from '../../../domain/profile';

export interface ProcessInstanceProfileOutPort {
    getProfile(name: string): Profile | undefined;
}
