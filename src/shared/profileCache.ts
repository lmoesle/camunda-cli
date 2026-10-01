import { ProfileCacheOutPort } from '../application/ports/out/profileCacheOutPort';
import { Profile } from '../domain/profile';

export interface ProfileReadApi {
    getProfiles(): Profile[];
    getProfile(name: string): Profile | undefined;
}

export class ProfileCache implements ProfileReadApi, ProfileCacheOutPort {
    private profiles: Profile[] = [];

    getProfiles(): Profile[] {
        return structuredClone(this.profiles);
    }

    getProfile(name: string): Profile | undefined {
        const profile = this.profiles.find((entry) => entry.name.trim() === name.trim());
        return profile === undefined ? undefined : structuredClone(profile);
    }

    replaceProfiles(profiles: Profile[]): void {
        this.profiles = structuredClone(profiles);
    }
}
