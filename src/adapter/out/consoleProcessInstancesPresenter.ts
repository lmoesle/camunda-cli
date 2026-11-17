import { ShowProcessInstancesOutPort } from '../../application/ports/out/showProcessInstancesOutPort';
import { QueriedProcessInstance } from '../../domain/processInstanceQuery';

export class ConsoleProcessInstancesPresenter implements ShowProcessInstancesOutPort {
    constructor(private readonly writeLine: (line: string) => void = console.log) {}

    showProcessInstances(instances: QueriedProcessInstance[], json: boolean): void {
        if (json) {
            this.writeLine(JSON.stringify(instances, null, 2));
            return;
        }
        if (!instances.length) {
            this.writeLine('No ACTIVE process instances found.');
            return;
        }
        const tenant = instances.some((instance) => instance.tenantId !== undefined);
        const rows = [
            ['KEY', 'BPMN ID', 'VERSION', 'STATE', 'INCIDENT', 'START DATE', ...(tenant ? ['TENANT'] : [])],
            ...instances.map((instance) => [instance.key, instance.bpmnProcessId, String(instance.processVersion), instance.state,
                String(instance.incident), instance.startDate, ...(tenant ? [instance.tenantId ?? '-'] : [])].map(safeCell)),
        ];
        const widths = rows.reduce((widths, row) => row.map((cell, column) => Math.max(widths[column], cell.length)),
            rows[0].map(() => 0));
        this.writeLine(rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join(' | ').trimEnd()).join('\n'));
    }
}

function safeCell(value: string): string {
    // eslint-disable-next-line no-control-regex -- terminal-safety boundary
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
