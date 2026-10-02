import { ListIncidentsCommand, ListIncidentsInPort } from '../ports/in/listIncidentsInPort';
import { IncidentProfileOutPort } from '../ports/out/incidentProfileOutPort';
import { IncidentConnection, IncidentSearchOutPort } from '../ports/out/incidentSearchOutPort';
import { ShowIncidentsOutPort } from '../ports/out/showIncidentsOutPort';
import { Profile } from '../../domain/profile';

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
        const incidents = await this.search.searchActiveIncidents(incidentConnection(profile));
        this.presenter.showIncidents(incidents, command.json ?? false);
    }
}

function required(value: string | undefined, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Profile ${field} is required and must not be blank for incidents.`);
    }
    return value;
}

function endpoint(value: string | undefined, field: string): string {
    const text = required(value, field).trim();
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        throw new Error(`Profile ${field} must be a valid HTTP(S) endpoint URL.`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        text.includes('?') || text.includes('#')) {
        throw new Error(`Profile ${field} must use HTTP(S) without credentials, query, or fragment.`);
    }
    return url.toString().replace(/\/+$/, '');
}

function incidentConnection(profile: Profile): IncidentConnection {
    const operateUrl = endpoint(profile.operateUrl, 'operateUrl');
    const oAuthUrl = endpoint(profile.oAuthUrl, 'oAuthUrl');
    const clientId = required(profile.clientId, 'clientId');
    const clientSecret = required(profile.clientSecret, 'clientSecret');
    const saas = new URL(operateUrl).hostname.endsWith('.operate.camunda.io') ||
        new URL(oAuthUrl).hostname === 'login.cloud.camunda.io';
    const audience = profile.audience !== undefined || saas ? required(profile.audience, 'audience') : undefined;
    return { operateUrl, oAuthUrl, clientId, clientSecret, audience };
}
