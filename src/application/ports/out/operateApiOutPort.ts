import { OperateConnection } from '../../../domain/operateConnection';
import { OperateRequest } from '../../../domain/operateApiTypes';

export interface OperateApiOutPort {
    execute(connection: OperateConnection, request: OperateRequest): Promise<unknown>;
}
