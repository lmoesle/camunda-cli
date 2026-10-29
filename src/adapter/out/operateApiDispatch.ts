import { AxiosInstance, AxiosPromise, RawAxiosRequestConfig } from 'axios';
import { OperateRequest } from '../../domain/operateApiTypes';
import { assertReadOnlyOperateDispatch } from '../../domain/operateApiPolicy';
import {
    DecisionDefinitionApi, DecisionInstanceApi, DecisionRequirementsApi, FlownodeInstanceApi,
    IncidentApi, ProcessDefinitionApi, ProcessInstanceApi, VariableApi,
} from './generated/operate/api';
import { Configuration } from './generated/operate/configuration';

type DispatchRequest = Pick<OperateRequest, 'operationId' | 'body'> & Partial<Pick<OperateRequest, 'pathArguments' | 'method' | 'path'>>;

export function dispatchOperateRequest(http: AxiosInstance, basePath: string, token: string | undefined, request: DispatchRequest): AxiosPromise<unknown> {
    assertReadOnlyOperateDispatch(request);
    const configuration = new Configuration({ basePath, accessToken: token });
    // The generated serializer defaults an absent body to {}. Preserve the exact
    // serialized JSON (and absence), including int64s and marker-colliding objects.
    const transport = {
        defaults: {},
        request: (options: RawAxiosRequestConfig) => http.request({ ...options, data: request.body }),
    } as AxiosInstance;
    const variables = new VariableApi(configuration, basePath, transport);
    const instances = new ProcessInstanceApi(configuration, basePath, transport);
    const definitions = new ProcessDefinitionApi(configuration, basePath, transport);
    const incidents = new IncidentApi(configuration, basePath, transport);
    const nodes = new FlownodeInstanceApi(configuration, basePath, transport);
    const requirements = new DecisionRequirementsApi(configuration, basePath, transport);
    const decisions = new DecisionInstanceApi(configuration, basePath, transport);
    const decisionDefinitions = new DecisionDefinitionApi(configuration, basePath, transport);
    const options: RawAxiosRequestConfig = {
        timeout: 30000, maxRedirects: 0, responseType: 'text',
        transformRequest: [(value: unknown) => value], transformResponse: [(value: unknown) => value],
    };
    function call<P>(method: (parameters: P, options?: RawAxiosRequestConfig) => AxiosPromise, parameters: Record<string, unknown>) {
        // Generated number/model types cannot express lossless int64 strings or
        // pre-serialized JSON. Only prepared arguments cross this cast.
        return method(parameters as P, options);
    }
    const key = { key: request.pathArguments?.key };
    const operations: Record<string, () => AxiosPromise<unknown>> = {
        byKey: () => call(variables.byKey.bind(variables), key),
        search: () => call(variables.search.bind(variables), { queryVariable: request.body }),
        byKey_1: () => call(instances.byKey1.bind(instances), key),
        getStatistics: () => call(instances.getStatistics.bind(instances), key),
        sequenceFlowsByKey: () => call(instances.sequenceFlowsByKey.bind(instances), key),
        search_1: () => call(instances.search1.bind(instances), { queryProcessInstance: request.body }),
        byKey_2: () => call(definitions.byKey2.bind(definitions), key),
        xmlByKey: () => call(definitions.xmlByKey.bind(definitions), key),
        search_2: () => call(definitions.search2.bind(definitions), { queryProcessDefinition: request.body }),
        byKey_3: () => call(incidents.byKey3.bind(incidents), key),
        search_3: () => call(incidents.search3.bind(incidents), { queryIncident: request.body }),
        byKey_4: () => call(nodes.byKey4.bind(nodes), key),
        search_4: () => call(nodes.search4.bind(nodes), { queryFlowNodeInstance: request.body }),
        byKey_5: () => call(requirements.byKey5.bind(requirements), key),
        xmlByKey_1: () => call(requirements.xmlByKey1.bind(requirements), key),
        search_5: () => call(requirements.search5.bind(requirements), { queryDecisionRequirements: request.body }),
        byId: () => call(decisions.byId.bind(decisions), { id: request.pathArguments?.id }),
        search_6: () => call(decisions.search6.bind(decisions), { queryDecisionInstance: request.body }),
        byKey_6: () => call(decisionDefinitions.byKey6.bind(decisionDefinitions), key),
        search_7: () => call(decisionDefinitions.search7.bind(decisionDefinitions), { queryDecisionDefinition: request.body }),
    };
    const invoke = operations[request.operationId];
    if (!Object.prototype.hasOwnProperty.call(operations, request.operationId)) throw new Error('Unknown Operate API operation.');
    return invoke();
}
