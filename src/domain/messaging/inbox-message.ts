export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

/**
 * Mensagem recebida da fila, registrada por consumidor. A chave (consumerName, messageId)
 * torna a entrega idempotente: a mesma mensagem, entregue de novo, não produz efeito duplicado.
 *
 * Ciclo de vida: recebida -> processada (final). O registro é gravado na mesma transação
 * do efeito de negócio, então só fica processada quando o efeito foi confirmado.
 */
export class InboxMessage {
  private constructor(private readonly fields: InboxMessageState) {}

  static receive(props: { consumerName: string; messageId: string; payloadHash: string; at: Date }): InboxMessage {
    return new InboxMessage({
      consumerName: props.consumerName,
      messageId: props.messageId,
      payloadHash: props.payloadHash,
      receivedAt: props.at,
      processedAt: null,
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...state });
  }

  get consumerName(): string {
    return this.fields.consumerName;
  }
  get messageId(): string {
    return this.fields.messageId;
  }
  get isProcessed(): boolean {
    return this.fields.processedAt !== null;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed) {
      throw new Error(`inbox message ${this.fields.consumerName}/${this.fields.messageId} was already processed`);
    }
    this.fields.processedAt = at;
  }

  toState(): InboxMessageState {
    return { ...this.fields };
  }
}
