import { Profile } from '../../../domain/profile';

export interface IncidentProfileOutPort {
    getProfile(name: string): Profile | undefined;
}
