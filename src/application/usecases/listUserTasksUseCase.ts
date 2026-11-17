import { restConnection } from '../../domain/restConnection';
import { userTaskKey } from '../../domain/userTask';
import { ListUserTasksCommand, ListUserTasksInPort } from '../ports/in/listUserTasksInPort';
import { UserTaskOutPort } from '../ports/out/userTaskOutPort';
import { UserTaskProfileOutPort } from '../ports/out/userTaskProfileOutPort';
import { ShowUserTasksOutPort } from '../ports/out/showUserTasksOutPort';

export class ListUserTasksUseCase implements ListUserTasksInPort {
    constructor(
        private readonly profiles: UserTaskProfileOutPort,
        private readonly tasks: UserTaskOutPort,
        private readonly presenter: ShowUserTasksOutPort,
    ) {}

    async listUserTasks(command: ListUserTasksCommand): Promise<void> {
        const key = command.processInstance === undefined ? undefined : userTaskKey(command.processInstance);
        if (typeof command.profile !== 'string' || !command.profile.trim()) {
            throw new Error('The usertasks get command requires a nonblank profile name.');
        }
        const profile = this.profiles.getProfile(command.profile.trim());
        if (!profile) throw new Error('The selected profile does not exist. Add it with the add profile command.');
        const session = await this.tasks.connect(restConnection(profile, 'usertasks get'));
        const tasks = await session.search(key);
        this.presenter.showUserTasks(tasks, command.json ?? false);
    }
}
