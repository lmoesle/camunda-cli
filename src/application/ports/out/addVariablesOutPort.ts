import { RestConnection } from '../../../domain/restConnection';

export interface AddVariablesSession {
    update(processInstanceKey: string, variables: Record<string, unknown>): Promise<void>;
}

export interface AddVariablesOutPort {
    connect(connection: RestConnection): Promise<AddVariablesSession>;
}
