import { Incident } from '../../../domain/incident';

export interface IncidentConnection {
    operateUrl: string;
    oAuthUrl: string;
    clientId: string;
    clientSecret: string;
    audience?: string;
}

export interface IncidentSearchOutPort {
    searchActiveIncidents(connection: IncidentConnection): Promise<Incident[]>;
}
