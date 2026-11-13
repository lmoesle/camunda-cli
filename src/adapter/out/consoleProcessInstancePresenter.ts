import { ShowProcessInstanceOutPort } from '../../application/ports/out/showProcessInstanceOutPort';

export class ConsoleProcessInstancePresenter implements ShowProcessInstanceOutPort {
    constructor(private readonly writeLine: (line: string) => void = console.log) {}

    showCreated(processInstanceKey: string): void {
        this.writeLine(`Created process instance ${processInstanceKey}.`);
    }
}
