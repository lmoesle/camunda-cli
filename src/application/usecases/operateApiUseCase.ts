import { validateOperateRequest } from '../../domain/operateApi';
import { OperateMetadata } from '../../domain/operateApiTypes';
import { operateConnection } from '../../domain/operateConnection';
import { OperateApiCommand, OperateApiInPort } from '../ports/in/operateApiInPort';
import { OperateApiProfileOutPort } from '../ports/out/operateApiProfileOutPort';
import { OperateApiOutPort } from '../ports/out/operateApiOutPort';
import { ShowApiResultOutPort } from '../ports/out/showApiResultOutPort';

export class OperateApiUseCase implements OperateApiInPort {
    constructor(
        private readonly profiles: OperateApiProfileOutPort,
        private readonly api: OperateApiOutPort,
        private readonly presenter: ShowApiResultOutPort,
        private readonly metadata: OperateMetadata,
    ) {}

    async invokeApi(command: OperateApiCommand): Promise<void> {
        if (command.usecase === 'ls') {
            if (command.requestJson !== undefined || command.profile !== undefined) throw new Error('api ls takes no request or profile.');
            this.presenter.showApiResult(this.metadata.operations);
            return;
        }
        const request = validateOperateRequest(command.usecase, command.requestJson ?? '', this.metadata);
        if (typeof command.profile !== 'string' || !command.profile.trim()) throw new Error('The api command requires a nonblank --profile.');
        const profile = this.profiles.getProfile(command.profile.trim());
        if (!profile) throw new Error('The selected profile does not exist. Add it with the add profile command.');
        const result = await this.api.execute(operateConnection(profile, 'api'), request);
        this.presenter.showApiResult(result);
    }
}
