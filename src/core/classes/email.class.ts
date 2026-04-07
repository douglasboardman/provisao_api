export class Email {
  private readonly _value: string;

  /**
   * Objeto Email.
   * @param email O valor do e-mail já validado e normalizado.
   */
  private constructor(email: string) {
    this._value = email;
  }

  /**
   * Getter público para acessar o valor do e-mail de forma segura (somente leitura).
   */
  public get value(): string {
    return this._value;
  }

  /**
   * Método estático (fábrica) para criar uma nova instância de Email.
   * É o único ponto de entrada para a criação de objetos desta classe.
   * @param email O e-mail candidato (string pura).
   * @returns Uma nova instância de Email se a validação for bem-sucedida.
   * @throws Lança um erro se o e-mail for inválido.
   */
  public static create(email: string): Email {
    if (!this.isValid(email)) {
      throw new Error(`O e-mail fornecido "${email}" é inválido.`);
    }
    // Normaliza o e-mail para minúsculas e remove espaços extras.
    const normalizedEmail = email.trim().toLowerCase();
    return new Email(normalizedEmail);
  }

  /**
   * Método de validação estático e privado.
   * @param email A string a ser validada.
   * @returns 'true' se o e-mail for válido, 'false' caso contrário.
   */
  private static isValid(email: string): boolean {
    if (!email) {
      return false;
    }
    // Expressão regular (regex) padrão para validar o formato de e-mails.
    const emailRegex = new RegExp(
      /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
    );
    return emailRegex.test(email);
  }

  /**
   * 
   * @param email Endereço de e-mail em formato string.
   * @returns Valor booleano que indica se o valor informado representa um endereço válido de e-mail ou não.
   */
  public static isEmail(email: string): boolean {
    return this.isValid(email);
  }

  /**
   * Retorna a parte local do e-mail (antes do @).
   */
  public get localPart(): string {
    return this._value.split('@')[0];
  }

  /**
   * Retorna o domínio do e-mail (depois do @).
   */
  public get domain(): string {
    return this._value.split('@')[1];
  }

  /**
   * Compara esta instância de Email com outra para verificar igualdade de valor.
   * @param other Outra instância de Email.
   */
  public equals(other: Email): boolean {
    return this.value === other.value;
  }
}