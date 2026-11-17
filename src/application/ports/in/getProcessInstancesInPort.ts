export interface GetProcessInstancesCommand {
    profile: string;
    filter?: string;
    json?: boolean;
}

export interface GetProcessInstancesInPort {
    getProcessInstances(command: GetProcessInstancesCommand): Promise<void>;
}
