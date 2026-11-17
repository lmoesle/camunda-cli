import { RestConnection } from '../../../domain/restConnection';
import { UserTask } from '../../../domain/userTask';

export interface UserTaskSession {
    search(processInstanceKey?: string): Promise<UserTask[]>;
    complete(key: string, variables: Record<string, unknown>): Promise<void>;
}

export interface UserTaskOutPort {
    connect(connection: RestConnection): Promise<UserTaskSession>;
}
