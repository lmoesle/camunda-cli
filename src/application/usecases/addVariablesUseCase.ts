import { AddVariablesBatchFailure, processInstanceKeys } from '../../domain/addVariables';
import { restConnection } from '../../domain/restConnection';
import { parseVariables } from '../../domain/variables';
import { AddVariablesCommand, AddVariablesInPort } from '../ports/in/addVariablesInPort';
import { AddVariablesOutPort } from '../ports/out/addVariablesOutPort';
import { AddVariablesProfileOutPort } from '../ports/out/addVariablesProfileOutPort';
import { ShowAddVariablesOutPort } from '../ports/out/showAddVariablesOutPort';

export class AddVariablesUseCase implements AddVariablesInPort {
    constructor(private readonly profiles: AddVariablesProfileOutPort, private readonly variables: AddVariablesOutPort,
        private readonly presenter: ShowAddVariablesOutPort) {}

    async addVariables(command: AddVariablesCommand): Promise<void> {
        const keys = processInstanceKeys(command.processInstances);
        const variables = parseVariables(command.variables);
        if (typeof command.profile !== 'string' || !command.profile.trim()) {
            throw new Error('The add-variables command requires a nonblank profile name.');
        }
        const profile = this.profiles.getProfile(command.profile.trim());
        if (!profile) throw new Error('The selected profile does not exist. Add it with the add profile command.');
        const session = await this.variables.connect(restConnection(profile, 'add-variables'));
        let successCount = 0;
        let failedCount = 0;
        for (const key of keys) {
            try { await session.update(key, variables); }
            catch (error) {
                const status = error instanceof Error ? error.message.match(/HTTP \d{3}/)?.[0] : undefined;
                failedCount++;
                this.presenter.showFailed(`Variable update failed for process instance ${key}${status ? ` (${status})` : ''}. ` +
                    'Successful updates remain committed; the failed outcome may be uncertain. Check cluster state before rerunning. No retry or rollback was attempted.');
                continue;
            }
            successCount++;
            this.presenter.showUpdated(key);
        }
        this.presenter.showSummary(successCount, failedCount);
        if (failedCount > 0) throw new AddVariablesBatchFailure(successCount, failedCount);
    }
}
