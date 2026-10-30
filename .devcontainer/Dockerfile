# Imagem do container de desenvolvimento: o Bun, mais o Git para o controle de código fonte do VS Code.
FROM oven/bun:1

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
