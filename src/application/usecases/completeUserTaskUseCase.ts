import { restConnection } from '../../domain/restConnection';
import { userTaskKey, UserTaskFailure } from '../../domain/userTask';
import { parseVariables } from '../../domain/variables';
import { CompleteUserTaskCommand, CompleteUserTaskInPort } from '../ports/in/completeUserTaskInPort';
import { UserTaskOutPort } from '../ports/out/userTaskOutPort';
import { UserTaskProfileOutPort } from '../ports/out/userTaskProfileOutPort';
import { ShowUserTasksOutPort } from '../ports/out/showUserTasksOutPort';

export class CompleteUserTaskUseCase implements CompleteUserTaskInPort {
    constructor(
        private readonly profiles: UserTaskProfileOutPort,
        private readonly tasks: UserTaskOutPort,
        private readonly presenter: ShowUserTasksOutPort,
    ) {}

    async completeUserTask(command: CompleteUserTaskCommand): Promise<void> {
        const key = userTaskKey(command.id);
        const variables = parseVariables(command.variables);
        if (typeof command.profile !== 'string' || !command.profile.trim()) {
            throw new Error('The usertask complete command requires a nonblank profile name.');
        }
        const profile = this.profiles.getProfile(command.profile.trim());
        if (!profile) throw new Error('The selected profile does not exist. Add it with the add profile command.');
        const session = await this.tasks.connect(restConnection(profile, 'usertask complete'));
        try { await session.complete(key, variables); }
        catch (error) {
            const reason = error instanceof UserTaskFailure ? error.message : 'User task completion failed.';
            // eslint-disable-next-line preserve-caught-error -- Untrusted causes can expose credentials and variables.
            throw new Error(`${reason} The completion outcome may be uncertain. Check cluster state before rerunning.`);
        }
        this.presenter.showCompleted(key);
    }
}
