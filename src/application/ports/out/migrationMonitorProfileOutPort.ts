import { Profile } from '../../../domain/profile';

export interface MigrationMonitorProfileOutPort {
    getProfile(name: string): Profile | undefined;
}
