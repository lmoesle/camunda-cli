export interface HelloWorldGreeting {
    message: string;
}

export function createHelloWorldGreeting(name = 'World'): HelloWorldGreeting {
    const trimmedName = name.trim();
    const recipient = trimmedName.length > 0 ? trimmedName : 'World';

    return {
        message: `Hello, ${recipient}!`,
    };
}
