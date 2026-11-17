import { OperateConnection } from '../../../domain/operateConnection';
import { ProcessInstanceQuery, QueriedProcessInstance } from '../../../domain/processInstanceQuery';

export interface ProcessInstanceSearchOutPort {
    searchActiveProcessInstances(connection: OperateConnection, query: ProcessInstanceQuery): Promise<QueriedProcessInstance[]>;
}
