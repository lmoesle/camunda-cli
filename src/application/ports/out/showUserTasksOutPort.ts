import { UserTask } from '../../../domain/userTask';

export interface ShowUserTasksOutPort {
    showUserTasks(tasks: UserTask[], json: boolean): void;
    showCompleted(key: string): void;
}
