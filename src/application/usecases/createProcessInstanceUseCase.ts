import { ProcessInstanceFailure, processInstanceRequest } from '../../domain/processInstance';
import { restConnection } from '../../domain/restConnection';
import { CreateProcessInstanceCommand, CreateProcessInstanceInPort } from '../ports/in/createProcessInstanceInPort';
import { ProcessInstanceOutPort } from '../ports/out/processInstanceOutPort';
import { ProcessInstanceProfileOutPort } from '../ports/out/processInstanceProfileOutPort';
import { ShowProcessInstanceOutPort } from '../ports/out/showProcessInstanceOutPort';

export class CreateProcessInstanceUseCase implements CreateProcessInstanceInPort {
    constructor(
        private readonly profiles: ProcessInstanceProfileOutPort,
        private readonly instances: ProcessInstanceOutPort,
        private readonly presenter: ShowProcessInstanceOutPort,
    ) {}

    async createProcessInstance(command: CreateProcessInstanceCommand): Promise<void> {
        const request = processInstanceRequest(command.id, command.version, command.variables);
        if (typeof command.profile !== 'string' || !command.profile.trim()) {
            throw new Error('The create-process-instance command requires a nonblank profile name.');
        }
        const profile = this.profiles.getProfile(command.profile.trim());
        if (!profile) throw new Error('The selected profile does not exist. Add it with the add profile command.');
        const session = await this.instances.connect(restConnection(profile, 'create-process-instance'));
        let key: string;
        try { key = await session.create(request); }
        catch (error) {
            const reason = error instanceof ProcessInstanceFailure ? error.message : 'Process instance creation failed.';
            // eslint-disable-next-line preserve-caught-error -- Untrusted causes can expose credentials and variables.
            throw new Error(`${reason} The creation outcome may be uncertain. Check cluster state before rerunning.`);
        }
        this.presenter.showCreated(key);
    }
}
