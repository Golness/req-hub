import type { zh } from './locales/types';
import type {} from '@deepseek-ai/dsh-client-locale/client';
declare module '@deepseek-ai/dsh-client-locale/client' {
  interface LocaleNamespaceMap { reqHub: typeof zh }
}

export declare function t(key: keyof typeof zh, params?: Record<string, unknown>): string;
export declare function installLocale(ctx: import("@deepseek-ai/cordis").Context): () => void;
export declare const NAMESPACE: "reqHub";
