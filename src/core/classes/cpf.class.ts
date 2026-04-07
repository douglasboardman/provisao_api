export class Cpf {
  private readonly _value: string;

  /**
   * O construtor é privado para forçar a criação de instâncias
   * através do método estático 'create', garantindo que nenhum
   * objeto Cpf possa ser criado em um estado inválido.
   * @param cpf O valor do CPF (11 dígitos numéricos).
   */
  private constructor(cpf: string) {
    this._value = cpf;
  }

  /**
   * Getter público para acessar o valor do CPF como uma string de 11 dígitos.
   * Ex: "12345678900"
   */
  public get value(): string {
    return this._value;
  }

  /**
   * Propriedade pertinente: retorna o CPF formatado com pontos e traço.
   * Ex: "123.456.789-00"
   */
  public get formatted(): string {
    return this._value.replace(
      /(\d{3})(\d{3})(\d{3})(\d{2})/,
      '$1.$2.$3-$4',
    );
  }

  /**
   * Método estático (fábrica) para criar uma nova instância de Cpf.
   * É o único ponto de entrada para a criação de objetos desta classe.
   * @param cpf O CPF candidato (pode estar formatado ou não).
   * @returns Uma nova instância de Cpf se a validação for bem-sucedida.
   * @throws Lança um erro se o CPF for inválido.
   */
  public static create(cpf: string): Cpf {
    if (!this.isValid(cpf)) {
      throw new Error(`O CPF fornecido "${cpf}" é inválido.`);
    }
    // Remove todos os caracteres não numéricos para obter o valor puro.
    const cleanedCpf = cpf.replace(/[^\d]/g, '');
    return new Cpf(cleanedCpf);
  }

  /**
   * Método de validação estático e público que implementa o algoritmo de validação de CPF.
   * @param cpf A string a ser validada.
   * @returns 'true' se o CPF for válido, 'false' caso contrário.
   */
  public static isValid(cpf: string): boolean {
    if (!cpf) {
      return false;
    }

    const cleanedCpf = cpf.replace(/[^\d]/g, '');

    if (cleanedCpf.length !== 11) {
      return false;
    }

    // Elimina CPFs inválidos conhecidos com todos os dígitos iguais.
    if (/^(\d)\1+$/.test(cleanedCpf)) {
      return false;
    }

    // Validação do primeiro dígito verificador
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += parseInt(cleanedCpf.charAt(i)) * (10 - i);
    }
    let remainder = 11 - (sum % 11);
    let firstDigit = remainder >= 10 ? 0 : remainder;

    if (firstDigit !== parseInt(cleanedCpf.charAt(9))) {
      return false;
    }

    // Validação do segundo dígito verificador
    sum = 0;
    for (let i = 0; i < 10; i++) {
      sum += parseInt(cleanedCpf.charAt(i)) * (11 - i);
    }
    remainder = 11 - (sum % 11);
    let secondDigit = remainder >= 10 ? 0 : remainder;

    if (secondDigit !== parseInt(cleanedCpf.charAt(10))) {
      return false;
    }

    return true;
  }

  /**
   * Compara esta instância de Cpf com outra para verificar igualdade de valor.
   * @param other Outra instância de Cpf.
   */
  public equals(other: Cpf): boolean {
    return this.value === other.value;
  }
}
