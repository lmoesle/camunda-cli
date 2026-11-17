import { GetProcessInstancesCommand, GetProcessInstancesInPort } from '../ports/in/getProcessInstancesInPort';
import { ProcessInstanceProfileOutPort } from '../ports/out/processInstanceProfileOutPort';
import { ProcessInstanceSearchOutPort } from '../ports/out/processInstanceSearchOutPort';
import { ShowProcessInstancesOutPort } from '../ports/out/showProcessInstancesOutPort';
import { operateConnection } from '../../domain/operateConnection';
import { processInstanceFilter } from '../../domain/processInstanceQuery';

export class GetProcessInstancesUseCase implements GetProcessInstancesInPort {
    constructor(
        private readonly profiles: ProcessInstanceProfileOutPort,
        private readonly search: ProcessInstanceSearchOutPort,
        private readonly presenter: ShowProcessInstancesOutPort,
    ) {}

    async getProcessInstances(command: GetProcessInstancesCommand): Promise<void> {
        const key = processInstanceFilter(command.filter);
        if (typeof command.profile !== 'string' || !command.profile.trim()) {
            throw new Error('The process-instances get command requires a nonblank profile name.');
        }
        const profile = this.profiles.getProfile(command.profile.trim());
        if (!profile) throw new Error('The selected profile does not exist. Add it with the add profile command.');
        const instances = await this.search.searchActiveProcessInstances(operateConnection(profile, 'process-instances get'),
            { key, includeVariables: command.json ?? false });
        this.presenter.showProcessInstances(instances, command.json ?? false);
    }
}
