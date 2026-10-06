import { RestConnection } from '../../../domain/restConnection';

export interface IncidentRetrySession {
    resetJobRetries(jobKey: string): Promise<void>;
    resolveIncident(incidentKey: string): Promise<void>;
}

export interface IncidentRetryOutPort {
    connect(connection: RestConnection): Promise<IncidentRetrySession>;
}
