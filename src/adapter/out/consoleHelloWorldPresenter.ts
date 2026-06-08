import { ShowHelloWorldOutPort } from '../../application/ports/out/helloWorldOutPort';
import { HelloWorldGreeting } from '../../domain/helloWorld';

export class ConsoleHelloWorldPresenter implements ShowHelloWorldOutPort {
    constructor(private writeLine: (line: string) => void = console.log) {}

    showHelloWorld(greeting: HelloWorldGreeting): void {
        this.writeLine(greeting.message);
    }
}
