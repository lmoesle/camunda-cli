import axios, { AxiosInstance } from 'axios';

/** Isolate explicit anonymous calls from inherited Axios credentials, without mutating defaults. */
export function anonymousHttp(http: AxiosInstance): AxiosInstance {
    const anonymous = axios.create(http.defaults);
    anonymous.interceptors.request.use((config) => {
        delete config.auth;
        config.withCredentials = false;
        config.headers.delete('Authorization');
        config.headers.delete('Proxy-Authorization');
        config.headers.delete('Cookie');
        return config;
    });
    return anonymous;
}
