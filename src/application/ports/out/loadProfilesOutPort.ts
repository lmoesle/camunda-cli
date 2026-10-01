import { Profile } from '../../../domain/profile';

export interface LoadProfilesOutPort {
    // undefined means no configuration exists; an empty array is valid storage.
    loadProfiles(): Promise<Profile[] | undefined>;
}
