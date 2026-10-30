import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { ProviderIdentityPort } from '../../application/auth/provider-identity.port.ts';
import { IDENTITY_PORT } from '../../nest-modules/wagering-module/tokens.ts';

/**
 * Guard das rotas de negócio. Delega a validação à ProviderIdentityPort: se a porta devolver
 * null, responde 401. Com o adaptador padrão (sem efeito), toda requisição passa como anônima.
 * O health check não usa este guard e continua aberto.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(IDENTITY_PORT) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { identity?: unknown }>();
    const identity = await this.identity.authenticate(request.headers.authorization);
    if (!identity) {
      throw new UnauthorizedException('authentication required');
    }
    request.identity = identity;
    return true;
  }
}
