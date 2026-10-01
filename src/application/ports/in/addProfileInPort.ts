import { Profile } from '../../../domain/profile';

export type AddProfileCommand = Profile;

export interface AddProfileInPort {
    addProfile(command: AddProfileCommand): Promise<void>;
}
