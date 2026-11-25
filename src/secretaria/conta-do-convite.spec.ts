import { contaDoConvite } from './conta-do-convite';

describe('conta do convite individual', () => {
  const admin = { email_login: 'admin@example.org', ativo: true };
  const secretario = { email_login: 'Secretario@example.org', ativo: true };
  const selecionar = (contas: typeof admin[]) =>
    contaDoConvite(contas, 'secretario@example.org', () => new Error('Conta indisponível'));

  it('escolhe a conta correspondente ao endereço individual', () => {
    expect(selecionar([admin, secretario])).toBe(secretario);
    expect(selecionar([secretario, admin])).toBe(secretario);
  });

  it('dispensa login apenas para pessoa sem conta', () => {
    expect(selecionar([])).toBeNull();
    expect(() => selecionar([admin])).toThrow('Conta indisponível');
    expect(() => selecionar([admin, { ...secretario, ativo: false }])).toThrow('Conta indisponível');
    expect(() => selecionar([secretario, { ...secretario, email_login: 'secretario@example.org' }])).toThrow('Conta indisponível');
  });
});
