import { createProfile } from '../../domain/profile';
import { AddProfileCommand, AddProfileInPort } from '../ports/in/addProfileInPort';
import { ProfileRepositoryOutPort } from '../ports/out/profileRepositoryOutPort';

export class AddProfileUseCase implements AddProfileInPort {
    constructor(private profileRepositoryOutPort: ProfileRepositoryOutPort) {}

    async addProfile(command: AddProfileCommand): Promise<void> {
        await this.profileRepositoryOutPort.addProfile(createProfile(command));
    }
}
