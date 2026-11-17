import { Profile } from '../../../domain/profile';

export interface UserTaskProfileOutPort {
    getProfile(name: string): Profile | undefined;
}
