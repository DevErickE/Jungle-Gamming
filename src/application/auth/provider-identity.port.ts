/**
 * Identidade de quem chama a API. Hoje não há autenticação real: o adaptador padrão
 * devolve uma identidade anônima. A troca por um provedor real (OIDC) acontece nesta porta,
 * sem mexer nos controllers nem nos casos de uso.
 */
export interface ProviderIdentity {
  /** Provedor autenticado, quando houver. */
  providerId: string | null;
  /** true quando a requisição não foi autenticada de fato (modo sem efeito). */
  anonymous: boolean;
}

export interface ProviderIdentityPort {
  /**
   * Valida o cabeçalho Authorization. Devolve a identidade, ou null quando a credencial
   * é inválida ou ausente (o guard responde 401).
   */
  authenticate(authorization: string | undefined): Promise<ProviderIdentity | null>;
}
