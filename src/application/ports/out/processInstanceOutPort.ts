import { ProcessInstanceRequest } from '../../../domain/processInstance';
import { RestConnection } from '../../../domain/restConnection';

export interface ProcessInstanceSession {
    create(request: ProcessInstanceRequest): Promise<string>;
}

export interface ProcessInstanceOutPort {
    connect(connection: RestConnection): Promise<ProcessInstanceSession>;
}
