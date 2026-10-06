export interface RetryIncidentCommand {
    incident: string;
    job: string;
    profile: string;
}

export interface RetryIncidentInPort {
    retryIncident(command: RetryIncidentCommand): Promise<void>;
}
