export interface ListIncidentsCommand {
    profile: string;
    json?: boolean;
}

export interface ListIncidentsInPort {
    listIncidents(command: ListIncidentsCommand): Promise<void>;
}
