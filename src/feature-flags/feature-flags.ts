/** Recursos futuros são fechados por padrão. A API continua sendo a autoridade. */
import { ExecutionContext, NotFoundException } from '@nestjs/common';

export type Feature = 'governanca' | 'orgaos' | 'orgaos_gestao' | 'secretaria' | 'livros' | 'assinaturas';

const etapas = ['pausado', 'acesso', 'governanca', 'secretaria'] as const;
type Etapa = typeof etapas[number];

export function etapasPorIgreja(config: string | undefined): ReadonlyMap<string, Etapa> | undefined {
  if (config === undefined) return undefined;
  const igrejas = new Map<string, Etapa>();
  for (const item of config.split(',').map(item => item.trim()).filter(Boolean)) {
    const [igreja, valor, ...extra] = item.split(':');
    if (extra.length || (igreja !== '*' && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(igreja)) ||
        !etapas.includes(valor as Etapa) || igrejas.has(igreja)) {
      throw new Error('PROVISAO_ROLLOUT contém igreja ou etapa inválida.');
    }
    igrejas.set(igreja, valor as Etapa);
  }
  return igrejas;
}

function permite(igreja: string, etapa: Etapa) {
  const rollout = etapasPorIgreja(process.env.PROVISAO_ROLLOUT);
  return !rollout || etapas.indexOf(rollout.get(igreja) ?? rollout.get('*') ?? 'pausado') >= etapas.indexOf(etapa);
}

export const solicitacaoDisponivel = (igreja: string) => permite(igreja, 'acesso');

export function recursoDaIgreja(feature: Feature, igreja: string) {
  const etapa = ['secretaria', 'livros', 'assinaturas'].includes(feature) ? 'secretaria' : 'governanca';
  return featureEnabled(feature) && permite(igreja, etapa);
}

export function exigirRecursoIgreja(context: ExecutionContext, ...features: Feature[]) {
  const { user } = context.switchToHttp().getRequest<{ user?: { igreja_id: string } }>();
  if (!user || features.some(feature => !recursoDaIgreja(feature, user.igreja_id))) {
    throw new NotFoundException('Recurso indisponível.');
  }
  return true;
}

export function recursosDaSessao(igreja: string) {
  return {
    governanca: recursoDaIgreja('governanca', igreja),
    orgaos: recursoDaIgreja('governanca', igreja) && recursoDaIgreja('orgaos', igreja),
    secretaria: recursoDaIgreja('secretaria', igreja),
  };
}

export function featureEnabled(feature: Feature, env: NodeJS.ProcessEnv = process.env): boolean {
  const key: Record<Feature, string> = {
    governanca: 'FEATURE_GOVERNANCA',
    orgaos: 'FEATURE_ORGAOS',
    orgaos_gestao: 'FEATURE_ORGAOS_GESTAO',
    secretaria: 'FEATURE_SECRETARIA',
    livros: 'FEATURE_SECRETARIA_LIVROS',
    assinaturas: 'FEATURE_SECRETARIA_ASSINATURAS',
  };
  return env[key[feature]] === 'true';
}
