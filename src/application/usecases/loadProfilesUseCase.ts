import { LoadProfilesInPort } from '../ports/in/loadProfilesInPort';
import { LoadProfilesOutPort } from '../ports/out/loadProfilesOutPort';
import { ProfileCacheOutPort } from '../ports/out/profileCacheOutPort';
import { ProfileNoticeOutPort } from '../ports/out/profileNoticeOutPort';

export class LoadProfilesUseCase implements LoadProfilesInPort {
    constructor(
        private repository: LoadProfilesOutPort,
        private cache: ProfileCacheOutPort,
        private notice: ProfileNoticeOutPort,
    ) {}

    async loadProfiles(): Promise<void> {
        const profiles = await this.repository.loadProfiles();
        this.cache.replaceProfiles(profiles ?? []);
        if (profiles === undefined) {
            this.notice.showMissingProfilesNotice();
        }
    }
}
