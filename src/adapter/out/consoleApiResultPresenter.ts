import { stringifyApiJson } from '../../domain/apiJson';
import { ShowApiResultOutPort } from '../../application/ports/out/showApiResultOutPort';

export class ConsoleApiResultPresenter implements ShowApiResultOutPort {
    constructor(private readonly writeLine: (line: string) => void = console.log) {}

    showApiResult(result: unknown): void {
        this.writeLine(stringifyApiJson(result, 2) ?? 'null');
    }
}
