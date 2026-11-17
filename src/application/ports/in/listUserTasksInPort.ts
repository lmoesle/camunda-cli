export interface ListUserTasksCommand {
    profile: string;
    processInstance?: string;
    json?: boolean;
}

export interface ListUserTasksInPort {
    listUserTasks(command: ListUserTasksCommand): Promise<void>;
}
