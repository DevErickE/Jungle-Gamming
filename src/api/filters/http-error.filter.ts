import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { toHttpError } from './http-errors.ts';

/** Converte qualquer exceção em { error: { code, message } } com o status correto. */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json({
        error: { code: 'HTTP_ERROR', message: exception.message },
      });
      return;
    }

    const mapped = toHttpError(exception);
    if (mapped.status >= 500) {
      this.logger.error(JSON.stringify({ level: 'error', code: mapped.code, message: describe(exception) }));
    }
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
