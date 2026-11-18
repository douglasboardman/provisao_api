import { featureEnabled } from './feature-flags';

describe('feature flags', () => {
  it('mantém recursos futuros fechados por padrão e exige ativação explícita', () => {
    expect(featureEnabled('governanca', {})).toBe(false);
    expect(featureEnabled('secretaria', { FEATURE_SECRETARIA: '1' })).toBe(false);
    expect(featureEnabled('governanca', { FEATURE_GOVERNANCA: 'true' })).toBe(true);
    expect(featureEnabled('orgaos', { FEATURE_GOVERNANCA: 'true' })).toBe(false);
    expect(featureEnabled('orgaos_gestao', { FEATURE_ORGAOS: 'true' })).toBe(false);
  });
});
