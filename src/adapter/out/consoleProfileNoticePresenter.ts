import { ProfileNoticeOutPort } from '../../application/ports/out/profileNoticeOutPort';

export class ConsoleProfileNoticePresenter implements ProfileNoticeOutPort {
    constructor(private writeLine: (line: string) => void = console.log) {}

    showMissingProfilesNotice(): void {
        this.writeLine('Please add a profile with the add profile command.');
    }
}
