declare module '@deepseek-ai/cordis' {
  export interface Context {
    effect(factory: () => void | (() => void), label?: string): void
    locale: {
      register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    }
    sessions: unknown
    slots: {
      inject(name: string, factory: () => unknown): void
      register(definition: unknown, component: unknown): () => void
    }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  export type SessionId = string & { readonly __sessionId: unique symbol }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {}
declare module '@deepseek-ai/dsh-client-locale/client' {}
declare module '@deepseek-ai/dsh-client-ui-layout/client' {}
declare module '@deepseek-ai/dsh-client-ui-renderer/client' {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {}
}
