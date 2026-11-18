import { createHmac } from 'crypto';
export function cancelToken(confirmationToken: string): string {
  return createHmac('sha256', Buffer.from(confirmationToken, 'hex')).update('provisao-cancelamento-acesso-v1').digest('hex');
}
