import { Profile } from '../../../domain/profile';

export interface AddVariablesProfileOutPort {
    getProfile(name: string): Profile | undefined;
}
