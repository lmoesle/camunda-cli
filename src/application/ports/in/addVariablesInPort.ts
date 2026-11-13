export interface AddVariablesCommand {
    profile: string;
    processInstances: string;
    variables: string;
}

export interface AddVariablesInPort {
    addVariables(command: AddVariablesCommand): Promise<void>;
}
