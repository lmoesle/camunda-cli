export interface CreateProcessInstanceCommand {
    id: string;
    version: string;
    variables: string;
    profile: string;
}

export interface CreateProcessInstanceInPort {
    createProcessInstance(command: CreateProcessInstanceCommand): Promise<void>;
}
