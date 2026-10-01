import { Profile } from '../../../domain/profile';

export interface ProfileRepositoryOutPort {
    listProfiles(): Promise<Profile[]>;
    addProfile(profile: Profile): Promise<void>;
}
