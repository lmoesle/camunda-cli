import { HelloWorldGreeting } from '../../../domain/helloWorld';

export interface ShowHelloWorldOutPort {
    showHelloWorld(greeting: HelloWorldGreeting): void;
}
