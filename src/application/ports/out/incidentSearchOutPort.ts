import { Incident } from '../../../domain/incident';
import { OperateConnection } from '../../../domain/operateConnection';

export type IncidentConnection = OperateConnection;

export interface IncidentSearchOutPort {
    searchActiveIncidents(connection: IncidentConnection): Promise<Incident[]>;
}
