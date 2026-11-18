import { z } from 'zod';
import { chave, dia, revisao, texto } from './secretaria.dto';

const comando = { ...chave, ...revisao, versao_id: z.uuid() };
const token = z.string().regex(/^[a-f0-9]{64}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const processoSchema = z.object(comando).strict();
export const enviarConviteSchema = processoSchema.extend({
  arrolado_id: z.uuid(),
  evidencia: texto,
  canal_individual: z.literal(true),
});
export const revogarConviteSchema = processoSchema.extend({ arrolado_id: z.uuid(), evidencia: texto });
export const consultaConviteSchema = z.object({ token }).strict();
export const arquivoConviteSchema = consultaConviteSchema.extend({
  arquivo_id: z.uuid().optional(),
  versao_id: z.uuid(),
  manifesto_sha256: sha256,
});
export const consentimento = 'Li a matriz aprovada e seus anexos e concordo em assinar eletronicamente esta versão.';
export const decisaoSchema = z.discriminatedUnion('decisao', [
  consultaConviteSchema.extend({
    decisao: z.literal('ASSINAR'),
    versao_id: z.uuid(),
    manifesto_sha256: sha256,
    consentimento: z.literal(true),
  }),
  consultaConviteSchema.extend({
    decisao: z.literal('RECUSAR'),
    versao_id: z.uuid(),
    manifesto_sha256: sha256,
    motivo: texto,
  }),
]);
export const conferenciaSchema = processoSchema
  .extend({
    evidencia: texto,
    via_sha256: sha256,
    assinaturas: z
      .array(z.object({ arrolado_id: z.uuid(), data: dia, evidencia: texto }).strict())
      .min(1)
      .max(1000),
  })
  .refine(
    (v) => new Set(v.assinaturas.map((a) => a.arrolado_id)).size === v.assinaturas.length,
    'Signatário repetido.',
  );
