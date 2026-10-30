/**
 * Códigos de falha estáveis e legíveis por máquina. O provedor usa o código para decidir
 * se reenvia, corrige o payload ou desiste. Taxonomia completa: ver ARCHITECTURE.md.
 */
export enum FailureCode {
  /** Aposta ou débito sem saldo suficiente. */
  InsufficientFunds = 'WALLET_INSUFFICIENT_FUNDS',
  /** Reversão cujo débito deixaria o saldo negativo. Operacionalmente diferente de aposta sem saldo. */
  ReversalWouldBeNegative = 'REVERSAL_WOULD_BE_NEGATIVE',
  /** Referência não apareceu dentro do limite de tentativas ou do TTL. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência pertence a outro provider, jogador, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo da referência não é aceito por esse tipo de transação. */
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  /** Referência existe, mas não está PROCESSED (ex.: foi rejeitada). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** REFUND ou ROLLBACK com valor diferente do valor da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** A referência já foi revertida (REFUND ou ROLLBACK). */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** A aposta referenciada já tem um desfecho (WIN ou LOSS). Cada BET recebe um único resultado. */
  ReferenceAlreadySettled = 'REFERENCE_ALREADY_SETTLED',
  /**
   * Falha de infraestrutura que persistiu até o limite de tentativas do consumidor. A transação
   * fica FAILED, em estado final, para auditoria. O provedor não deve reenviar sem investigar.
   */
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}
