import { QueriedProcessInstance } from '../../../domain/processInstanceQuery';

export interface ShowProcessInstancesOutPort {
    showProcessInstances(instances: QueriedProcessInstance[], json: boolean): void;
}
