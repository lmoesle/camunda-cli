import { Profile } from '../../../domain/profile';

export interface ProfileCacheOutPort {
    replaceProfiles(profiles: Profile[]): void;
}
