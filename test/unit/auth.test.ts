import { describe, expect, test } from 'bun:test';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ProviderIdentityPort } from '../../src/application/auth/provider-identity.port.ts';
import { AuthGuard } from '../../src/api/guards/auth.guard.ts';
import { NoOpIdentityAdapter } from '../../src/infrastructure/auth/no-op-identity.adapter.ts';

function contextWithHeaders(headers: Record<string, string>): ExecutionContext {
  const request: { headers: Record<string, string>; identity?: unknown } = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('ponto de extensão de autenticação', () => {
  test('adaptador sem efeito devolve identidade anônima', async () => {
    const identity = await new NoOpIdentityAdapter().authenticate(undefined);
    expect(identity).toEqual({ providerId: null, anonymous: true });
  });

  test('com o adaptador padrão, o guard deixa a requisição passar', async () => {
    const guard = new AuthGuard(new NoOpIdentityAdapter());
    expect(await guard.canActivate(contextWithHeaders({}))).toBe(true);
  });

  test('quando a porta rejeita a credencial, o guard responde 401', async () => {
    const rejecting: ProviderIdentityPort = { authenticate: async () => null };
    const guard = new AuthGuard(rejecting);
    await expect(guard.canActivate(contextWithHeaders({ authorization: 'Bearer invalido' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  test('a identidade autenticada fica disponível na requisição', async () => {
    const accepting: ProviderIdentityPort = {
      authenticate: async () => ({ providerId: 'provider-a', anonymous: false }),
    };
    const context = contextWithHeaders({ authorization: 'Bearer ok' });
    await new AuthGuard(accepting).canActivate(context);
    const request = context.switchToHttp().getRequest<{ identity?: unknown }>();
    expect(request.identity).toEqual({ providerId: 'provider-a', anonymous: false });
  });
});
