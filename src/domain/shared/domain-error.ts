/**
 * Violação de regra de domínio. O `code` é estável e legível por máquina,
 * para que a camada de aplicação possa mapear para um failureCode.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
