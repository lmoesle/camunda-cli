import { ListIncidentsCommand, ListIncidentsInPort } from '../ports/in/listIncidentsInPort';
import { IncidentProfileOutPort } from '../ports/out/incidentProfileOutPort';
import { IncidentSearchOutPort } from '../ports/out/incidentSearchOutPort';
import { ShowIncidentsOutPort } from '../ports/out/showIncidentsOutPort';
import { operateConnection } from '../../domain/operateConnection';

export class ListIncidentsUseCase implements ListIncidentsInPort {
    constructor(
        private readonly profiles: IncidentProfileOutPort,
        private readonly search: IncidentSearchOutPort,
        private readonly presenter: ShowIncidentsOutPort,
    ) {}

    async listIncidents(command: ListIncidentsCommand): Promise<void> {
        if (typeof command.profile !== 'string' || !command.profile.trim()) {
            throw new Error('The incidents command requires a nonblank profile name.');
        }
        const profile = this.profiles.getProfile(command.profile.trim());
        if (!profile) {
            // Do not echo untrusted profile names or stored values in diagnostics.
            throw new Error('The selected profile does not exist. Add it with the add profile command.');
        }
        const incidents = await this.search.searchActiveIncidents(operateConnection(profile, 'incidents'));
        this.presenter.showIncidents(incidents, command.json ?? false);
    }
}
