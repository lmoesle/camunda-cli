export interface ApiSchema {
    $ref?: string;
    type?: string;
    format?: string;
    properties?: Record<string, ApiSchema>;
    items?: ApiSchema;
    required?: string[];
    enum?: unknown[];
    description?: string;
    additionalProperties?: boolean | ApiSchema;
}

export interface ApiParameter {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema: ApiSchema;
}

interface ApiContent {
    [mediaType: string]: { schema: ApiSchema; examples?: unknown };
}

export interface ApiOperation {
    operationId: string;
    method: string;
    path: string;
    summary: string;
    parameters: ApiParameter[];
    requestBody?: { required?: boolean; description?: string; content: ApiContent };
}

export interface OperateMetadata {
    operations: ApiOperation[];
    schemas: Record<string, ApiSchema>;
}

export interface OperateRequest {
    operationId: string;
    pathArguments: Record<string, string>;
    queryArguments: Record<string, string>;
    method: string;
    path: string;
    query: string;
    body?: string;
}
