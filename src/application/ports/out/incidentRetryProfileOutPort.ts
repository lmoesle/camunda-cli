import { Profile } from '../../../domain/profile';

export interface IncidentRetryProfileOutPort {
    getProfile(name: string): Profile | undefined;
}
