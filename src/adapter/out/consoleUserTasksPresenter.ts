import { ShowUserTasksOutPort } from '../../application/ports/out/showUserTasksOutPort';
import { UserTask } from '../../domain/userTask';
import { stringifyApiJson } from '../../domain/apiJson';

export class ConsoleUserTasksPresenter implements ShowUserTasksOutPort {
    constructor(private readonly writeLine: (line: string) => void = console.log) {}

    showCompleted(key: string): void {
        this.writeLine(`Completed user task ${key}.`);
    }

    showUserTasks(tasks: UserTask[], json: boolean): void {
        if (json) {
            this.writeLine(stringifyApiJson(tasks, 2)!);
            return;
        }
        const rows = [
            ['USER TASK KEY', 'PROCESS INSTANCE KEY', 'ELEMENT ID', 'ASSIGNEE', 'STATE', 'CREATION DATE'],
            ...tasks.map((task) => [task.key, task.processInstanceKey, task.elementId, task.assignee ?? '-',
                task.state, task.creationDate].map(safeCell)),
        ];
        const widths = rows.reduce((widths, row) => row.map((cell, column) => Math.max(widths[column], cell.length)),
            rows[0].map(() => 0));
        this.writeLine(rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join(' | ').trimEnd()).join('\n'));
    }
}

function safeCell(value: string): string {
    // eslint-disable-next-line no-control-regex -- matching controls is the terminal-safety boundary
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
