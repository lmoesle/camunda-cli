import { createHelloWorldGreeting } from '../../domain/helloWorld';
import { SayHelloWorldCommand, SayHelloWorldInPort } from '../ports/in/helloWorldInPort';
import { ShowHelloWorldOutPort } from '../ports/out/helloWorldOutPort';

export class HelloWorldUseCase implements SayHelloWorldInPort {
    constructor(private showHelloWorldOutPort: ShowHelloWorldOutPort) {}

    async sayHelloWorld(command: SayHelloWorldCommand): Promise<void> {
        const greeting = createHelloWorldGreeting(command.name);

        this.showHelloWorldOutPort.showHelloWorld(greeting);
    }
}
