import { createDefaultCamundaCli, createHelloWorldGreeting, HelloWorldGreeting, HelloWorldUseCase } from '../src/index';
import { ShowHelloWorldOutPort } from '../src/application/ports/out/helloWorldOutPort';

describe('hello world domain', () => {
    test('creates a default hello world greeting', () => {
        expect(createHelloWorldGreeting()).toEqual({ message: 'Hello, World!' });
    });

    test('creates a named greeting', () => {
        expect(createHelloWorldGreeting('Camunda')).toEqual({ message: 'Hello, Camunda!' });
    });
});

describe('hello world use case', () => {
    test('presents the greeting', async () => {
        const presenter = new CapturingHelloWorldPresenter();
        const useCase = new HelloWorldUseCase(presenter);

        await useCase.sayHelloWorld({ name: 'Camunda' });

        expect(presenter.greeting).toEqual({ message: 'Hello, Camunda!' });
    });
});

describe('camunda cli', () => {
    test('prints hello world from the CLI command', async () => {
        const output: string[] = [];
        const program = createDefaultCamundaCli({
            writeLine: (line) => output.push(line),
        });

        await program.parseAsync(['hello-world'], { from: 'user' });

        expect(output).toEqual(['Hello, World!']);
    });

    test('prints a named greeting from the CLI command', async () => {
        const output: string[] = [];
        const program = createDefaultCamundaCli({
            writeLine: (line) => output.push(line),
        });

        await program.parseAsync(['hello-world', 'Camunda'], { from: 'user' });

        expect(output).toEqual(['Hello, Camunda!']);
    });
});

class CapturingHelloWorldPresenter implements ShowHelloWorldOutPort {
    greeting: HelloWorldGreeting | undefined;

    showHelloWorld(greeting: HelloWorldGreeting): void {
        this.greeting = greeting;
    }
}
