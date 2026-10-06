import { ShowIncidentRetryOutPort } from '../../application/ports/out/showIncidentRetryOutPort';

export class ConsoleIncidentRetryPresenter implements ShowIncidentRetryOutPort {
    constructor(private readonly writeLine: (line: string) => void = console.log) {}

    showRetryRequested(incidentKey: string, jobKey: string): void {
        this.writeLine(`Retry requested for incident ${incidentKey}: job ${jobKey} retries set to 3 and incident resolution accepted.`);
    }
}
