export interface OperateApiCommand {
    usecase: string;
    requestJson?: string;
    profile?: string;
}

export interface OperateApiInPort {
    invokeApi(command: OperateApiCommand): Promise<void>;
}
