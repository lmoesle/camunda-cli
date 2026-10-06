import { IncidentRetryFailure, incidentRetryKey } from '../../domain/incidentRetry';
import { restConnection } from '../../domain/restConnection';
import { RetryIncidentCommand, RetryIncidentInPort } from '../ports/in/retryIncidentInPort';
import { IncidentRetryOutPort } from '../ports/out/incidentRetryOutPort';
import { IncidentRetryProfileOutPort } from '../ports/out/incidentRetryProfileOutPort';
import { ShowIncidentRetryOutPort } from '../ports/out/showIncidentRetryOutPort';

export class RetryIncidentUseCase implements RetryIncidentInPort {
    constructor(
        private readonly profiles: IncidentRetryProfileOutPort,
        private readonly retries: IncidentRetryOutPort,
        private readonly presenter: ShowIncidentRetryOutPort,
    ) {}

    async retryIncident(command: RetryIncidentCommand): Promise<void> {
        const incidentKey = incidentRetryKey(command.incident, 'incident');
        const jobKey = incidentRetryKey(command.job, 'job');
        if (typeof command.profile !== 'string' || !command.profile.trim()) {
            throw new Error('The incident retry command requires a nonblank profile name.');
        }
        const profile = this.profiles.getProfile(command.profile.trim());
        if (!profile) throw new Error('The selected profile does not exist. Add it with the add profile command.');
        const session = await this.retries.connect(restConnection(profile, 'incident retry'));
        await session.resetJobRetries(jobKey);
        try {
            await session.resolveIncident(incidentKey);
        } catch (error) {
            const reason = error instanceof IncidentRetryFailure ? error.message : 'Incident resolution failed.';
            throw new Error(`${reason} Job retries have already been updated; no rollback was attempted. ` +
                'The failed request outcome may be uncertain. Check state before rerunning.');
        }
        this.presenter.showRetryRequested(incidentKey, jobKey);
    }
}
