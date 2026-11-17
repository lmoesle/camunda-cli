export interface CompleteUserTaskCommand {
    id: string;
    profile: string;
    variables: string;
}

export interface CompleteUserTaskInPort {
    completeUserTask(command: CompleteUserTaskCommand): Promise<void>;
}
