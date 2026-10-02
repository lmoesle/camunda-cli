import { Incident } from '../../../domain/incident';

export interface ShowIncidentsOutPort {
    showIncidents(incidents: Incident[], json: boolean): void;
}
