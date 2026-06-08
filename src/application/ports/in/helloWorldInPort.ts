export interface SayHelloWorldInPort {
    sayHelloWorld(command: SayHelloWorldCommand): Promise<void>;
}

export interface SayHelloWorldCommand {
    name?: string;
}
