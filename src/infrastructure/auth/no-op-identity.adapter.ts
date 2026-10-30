import type { ProviderIdentity, ProviderIdentityPort } from '../../application/auth/provider-identity.port.ts';

/**
 * Adaptador sem efeito: aceita qualquer requisição como anônima. Ponto de extensão
 * para uma autenticação real (ver ARCHITECTURE.md, seção 10). Não usar em produção.
 */
export class NoOpIdentityAdapter implements ProviderIdentityPort {
  async authenticate(_authorization?: string): Promise<ProviderIdentity> {
    return { providerId: null, anonymous: true };
  }
}
