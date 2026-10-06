import { ShowIncidentsOutPort } from '../../application/ports/out/showIncidentsOutPort';
import { Incident } from '../../domain/incident';

export class ConsoleIncidentsPresenter implements ShowIncidentsOutPort {
    constructor(private readonly writeLine: (line: string) => void = console.log) {}

    showIncidents(incidents: Incident[], json: boolean): void {
        if (json) {
            this.writeLine(JSON.stringify(incidents, null, 2));
            return;
        }
        const rows = [
            ['INCIDENT KEY', 'PROCESS INSTANCE KEY', 'JOB KEY', 'TYPE', 'CREATION TIME', 'MESSAGE'],
            ...incidents.map((incident) => [incident.key, incident.processInstanceKey, incident.jobKey ?? '-', incident.type,
                incident.creationTime, incident.message].map(safeCell)),
        ];
        const widths = rows.reduce((widths, row) => row.map((cell, column) => Math.max(widths[column], cell.length)),
            rows[0].map(() => 0));
        this.writeLine(rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join(' | ').trimEnd()).join('\n'));
    }
}

function safeCell(value: string): string {
    // Render controls visibly, including escape sequences and bidi formatting controls.
    // eslint-disable-next-line no-control-regex -- matching controls is the terminal-safety boundary
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
