import { Profile } from '../../../domain/profile';

export interface OperateApiProfileOutPort {
    getProfile(name: string): Profile | undefined;
}
