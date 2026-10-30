type Labels = Record<string, string>;

interface Family {
  type: 'counter' | 'gauge' | 'summary';
  help: string;
  values: Map<string, number>;
  /** Para summary: soma e contagem de observações, por série. */
  sums?: Map<string, number>;
  counts?: Map<string, number>;
}

/**
 * Métricas em memória do processo, em formato texto (Prometheus). Cada instância da
 * aplicação expõe as suas. Contadores só sobem, medidores são sobrescritos, e timings
 * viram summary (soma e contagem), suficiente para calcular a média.
 */
export class Metrics {
  private readonly families = new Map<string, Family>();

  /** Soma `by` ao contador. */
  increment(name: string, help: string, labels: Labels = {}, by = 1): void {
    const family = this.family(name, 'counter', help);
    const key = serialize(labels);
    family.values.set(key, (family.values.get(key) ?? 0) + by);
  }

  /** Define o valor atual de um medidor (ex.: lag da outbox). */
  gauge(name: string, help: string, value: number, labels: Labels = {}): void {
    const family = this.family(name, 'gauge', help);
    family.values.set(serialize(labels), value);
  }

  /** Registra uma observação de duração em segundos. */
  observe(name: string, help: string, seconds: number, labels: Labels = {}): void {
    const family = this.family(name, 'summary', help);
    const key = serialize(labels);
    family.sums = family.sums ?? new Map();
    family.counts = family.counts ?? new Map();
    family.sums.set(key, (family.sums.get(key) ?? 0) + seconds);
    family.counts.set(key, (family.counts.get(key) ?? 0) + 1);
  }

  /** Valor atual de um contador ou medidor. Usado em testes. */
  value(name: string, labels: Labels = {}): number {
    return this.families.get(name)?.values.get(serialize(labels)) ?? 0;
  }

  /** Número de observações de um summary. Usado em testes. */
  observations(name: string, labels: Labels = {}): number {
    return this.families.get(name)?.counts?.get(serialize(labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, family] of this.families) {
      lines.push(`# HELP ${name} ${family.help}`, `# TYPE ${name} ${family.type}`);
      if (family.type === 'summary') {
        for (const [labels, sum] of family.sums ?? []) {
          lines.push(`${name}_sum${wrap(labels)} ${sum}`);
          lines.push(`${name}_count${wrap(labels)} ${family.counts?.get(labels) ?? 0}`);
        }
        continue;
      }
      for (const [labels, value] of family.values) {
        lines.push(`${name}${wrap(labels)} ${value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private family(name: string, type: Family['type'], help: string): Family {
    let family = this.families.get(name);
    if (!family) {
      family = { type, help, values: new Map() };
      this.families.set(name, family);
    }
    return family;
  }
}

function serialize(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');
}

function wrap(labels: string): string {
  return labels ? `{${labels}}` : '';
}
