/**
 * Claude redacta lo que los informes de Ads dicen con palabras.
 *
 * Recibe el modelo ya calculado (report/ads-model.ts) y devuelve texto
 * estructurado: la interpretación de cada bloque, las acciones y, cada semana,
 * el análisis y el baseline de la cuenta. Las cifras de las tablas y de las
 * alertas nunca pasan por aquí: si Claude falla o no hay llave, el informe sale
 * igual, con la conclusión escrita con reglas.
 *
 * El system prompt es fijo y va con cache_control; lo que cambia —los datos de
 * la cuenta— va en el mensaje del usuario, después del prefijo cacheado.
 */

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { ADS_BLOCKS, ADS_AUDIENCE_BLOCKS, adsLabel, type AdsBlockId, type AdsReportData, type AdsKpis } from '../report/ads-model.js';

export type AdsAudience = 'cliente' | 'admin';
export type AdsEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const BLOCK_IDS = ADS_BLOCKS.map((b) => b.id) as [AdsBlockId, ...AdsBlockId[]];

export const ReportTextSchema = z.object({
  /** Dos a cuatro frases: lo primero que lee quien abre el informe. */
  conclusion: z.string(),
  bloques: z.array(z.object({ id: z.enum(BLOCK_IDS), texto: z.string() })),
  acciones: z.array(z.object({
    titulo: z.string(),
    detalle: z.string(),
    prioridad: z.enum(['alta', 'media', 'baja']),
  })),
});
export type ReportText = z.infer<typeof ReportTextSchema>;

export const WeeklySchema = z.object({
  resumen: z.string(),
  mejoro: z.array(z.string()),
  empeoro: z.array(z.string()),
  alertas: z.array(z.string()),
  acciones: z.array(z.string()),
  /** El contexto actualizado de la cuenta, para el próximo análisis. */
  baseline: z.string(),
});
export type WeeklyText = z.infer<typeof WeeklySchema>;

export interface AccountContext {
  /** Lo que una persona escribió sobre el negocio. Vacío si nadie lo ha hecho. */
  profile: string;
  baseline: string | null;
}

export interface WriteResult<T> {
  content: T;
  /** El modelo que respondió; con un fallback puede ser otro que el pedido. */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export class AdsWriterError extends Error {
  override readonly name = 'AdsWriterError';
}

// ── Lo que se le manda ──────────────────────────────────────────────────────

const r2 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100);
const r4 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10_000) / 10_000);

function kpis(k: AdsKpis): Record<string, number | null> {
  return {
    impresiones: k.impressions, clics: k.clicks, gasto: r2(k.cost), conversiones: r2(k.conversions),
    valor_conversiones: r2(k.conversionsValue), ctr: r4(k.ctr), cpc: r2(k.cpc), costo_por_conversion: r2(k.cpa),
    tasa_conversion: r4(k.convRate), roas: r2(k.roas),
  };
}

/** Cuántas filas de cada lista larga ve Claude. Son las de más gasto; se le dice. */
const LIMITES = { gruposDeAnuncios: 15, keywords: 40, terminos: 40, anuncios: 15, audiencias: 15, landing: 15, geo: 12 };

/** Los bloques que ese informe imprime y que tienen algo que decir: a los demás no se les pide texto. */
export function blocksWithData(d: AdsReportData, audience: AdsAudience): AdsBlockId[] {
  return ADS_BLOCKS.filter((b) => ADS_AUDIENCE_BLOCKS[audience].includes(b.id) && b.hasData(d)).map((b) => b.id);
}

/**
 * Los datos de la cuenta en el formato que lee Claude: nombres en español,
 * montos ya en la moneda de la cuenta y razones como fracción.
 */
export function aiPayload(d: AdsReportData): Record<string, unknown> {
  return {
    cuenta: d.site.name,
    moneda: d.currency,
    periodo: { actual: d.period.label, anterior: d.period.previousLabel, desde: d.period.current.start, hasta: d.period.current.end },
    totales: { actual: kpis(d.totals), anterior: d.previousTotals === null ? null : kpis(d.previousTotals) },
    ultimos_7_dias: { rango: d.week.range, actual: kpis(d.week.current), previos: kpis(d.week.previous) },
    campañas: d.campaigns.map((c) => ({
      nombre: c.name, estado: adsLabel(c.status), canal: adsLabel(c.channel), puja: adsLabel(c.bidding),
      presupuesto_diario: c.dailyBudget, uso_del_presupuesto: r4(c.budgetUse),
      cuota_impresiones: c.impressionShare, perdida_por_ranking: c.rankLostShare, perdida_por_presupuesto: c.budgetLostShare,
      ...kpis(c), anterior: c.previous === null ? null : kpis(c.previous),
    })),
    acciones_de_conversion: d.conversionActions.map((a) => ({
      nombre: a.name, categoria: a.category, tipo: a.type, cuenta_en_conversiones: a.primary,
      conversiones: a.conversions, todas_las_conversiones: a.allConversions, valor: a.conversionsValue,
    })),
    grupos_de_anuncios: d.adGroups.slice(0, LIMITES.gruposDeAnuncios).map((g) => ({ nombre: g.name, estado: adsLabel(g.status), ...kpis(g) })),
    keywords: d.keywords.slice(0, LIMITES.keywords).map((k) => ({
      texto: k.text, concordancia: adsLabel(k.matchType), grupo: k.adGroup, quality_score: k.qualityScore,
      relevancia_anuncio: k.adRelevance === null ? null : adsLabel(k.adRelevance),
      experiencia_pagina_destino: k.landingPage === null ? null : adsLabel(k.landingPage),
      ctr_esperado: k.expectedCtr === null ? null : adsLabel(k.expectedCtr),
      ...kpis(k),
    })),
    terminos_de_busqueda: d.searchTerms.slice(0, LIMITES.terminos).map((t) => ({
      termino: t.term, concordancia: adsLabel(t.matchType),
      estado: t.status === 'ADDED' ? 'ya es keyword' : t.status === 'EXCLUDED' ? 'negativa' : 'ninguno', ...kpis(t),
    })),
    anuncios: d.ads.slice(0, LIMITES.anuncios).map((a) => ({
      grupo: a.adGroup, tipo: a.type, aprobacion: adsLabel(a.approval), fuerza: adsLabel(a.strength),
      titulos: a.headlines.slice(0, 5), descripciones: a.descriptions.slice(0, 2), ...kpis({ ...a, ctr: null, cpc: null, cpa: null, convRate: null, roas: null }),
    })),
    pmax: d.assetGroups.length === 0 ? null : {
      asset_groups: d.assetGroups.map((g) => ({
        nombre: g.name, fuerza: adsLabel(g.strength), gasto: g.cost, conversiones: g.conversions, clics: g.clicks,
        assets_no_elegibles: g.assets.filter((a) => a.status === 'NOT_ELIGIBLE').length, assets: g.assets.length,
      })),
      categorias_de_busqueda: d.pmaxTerms.slice(0, 20).map((t) => ({ categoria: t.category, impresiones: t.impressions, clics: t.clicks, conversiones: t.conversions })),
    },
    audiencias: d.audiences.slice(0, LIMITES.audiencias).map((a) => ({ nombre: a.name, nivel: a.level === 'campaign' ? 'campaña' : 'grupo', ...kpis(a) })),
    dispositivos: d.devices.map((x) => ({ dispositivo: x.key, parte_del_gasto: r4(x.costShare), ...kpis(x) })),
    landing_pages: d.landing.slice(0, LIMITES.landing).map((l) => ({
      url: l.url, ...kpis(l),
      auditoria: l.health === null ? 'no auditada' : { http: l.health.httpStatus, carga_ms: l.health.loadMs, ok: l.health.ok },
    })),
    geografia: d.geo.slice(0, LIMITES.geo).map((x) => ({ region: x.key, parte_del_gasto: r4(x.costShare), ...kpis(x) })),
    genero: d.gender.map((x) => ({ genero: x.key, parte_del_gasto: r4(x.costShare), ...kpis(x) })),
    edad: d.age.map((x) => ({ edad: x.key, parte_del_gasto: r4(x.costShare), ...kpis(x) })),
    horario: {
      por_dia: d.schedule.byDay.map((x) => ({ dia: x.key, gasto: x.cost, conversiones: x.conversions, costo_por_conversion: r2(x.cpa) })),
      por_hora: d.schedule.byHour.map((x) => ({ hora: Number(x.key), gasto: x.cost, conversiones: x.conversions })),
    },
    alertas_calculadas: d.alerts.map((a) => ({ severidad: a.severity === 'critical' ? 'crítica' : 'aviso', titulo: a.title, detalle: a.detail })),
  };
}

// ── Instrucciones ───────────────────────────────────────────────────────────

const REGLAS = `
Reglas para todos los textos:
- Escribe en español de México, en prosa clara. Sin Markdown: nada de #, *, ni viñetas dentro de un texto; separa párrafos con una línea en blanco.
- Usa solo los datos que se te entregan. No inventes cifras, causas que los datos no muestren ni datos de otras fuentes.
- Cuando cites un número, cópialo de los datos. Los montos ya están en la moneda de la cuenta (no son micros). Las fracciones (ctr, tasa_conversion, cuota_impresiones, perdida_*, parte_del_gasto, uso_del_presupuesto) van de 0 a 1: exprésalas como porcentaje.
- El gasto de una campaña es el del periodo completo; presupuesto_diario es por día. Para compararlos usa uso_del_presupuesto, que ya está calculado. Que el gasto del periodo sea mucho mayor que el presupuesto diario es normal.
- Las listas de keywords, términos, landing pages y regiones vienen recortadas a las de más gasto: no digas que son todas.
- Las alertas_calculadas ya salieron de reglas y se imprimen aparte: no las repitas una por una; úsalas para priorizar.
- Escribe un bloque solo para los ids que se te piden. Cada bloque en uno o dos párrafos cortos.`.trim();

export const SYSTEM_BY_AUDIENCE: Record<AdsAudience, string> = {
  cliente: `Eres un consultor de Google Ads que le escribe al DUEÑO DEL NEGOCIO, que no es técnico.
Habla de resultados, de retorno, de dónde está su dinero y de qué está funcionando, sin jerga. Cuando uses una métrica, explica en una frase qué significa para el negocio. Las acciones son decisiones que el dueño puede entender y aprobar, no instrucciones técnicas.

${REGLAS}`,
  admin: `Eres un especialista senior en Google Ads que le escribe a quien ADMINISTRA la cuenta.
Sé técnico, directo y concreto: qué keywords pausar o negativizar, qué ajustes de puja por dispositivo, horario o región, qué presupuesto mover, qué Quality Score atacar y por qué componente, qué anuncios reescribir. Cada acción dice qué hacer, dónde y qué se espera. Ordena las acciones por impacto en dinero.

${REGLAS}`,
};

export const SYSTEM_WEEKLY = `Eres un analista senior de Google Ads que revisa una cuenta cada semana.
Comparas los datos de esta semana contra el baseline de la cuenta (lo que se sabía de ella hasta la semana pasada) y su perfil (lo que el negocio dijo de sí mismo). Dices qué mejoró y qué empeoró, con números; qué alertas siguen vigentes o son nuevas; y dos o tres acciones concretas.

Además reescribes el baseline: un texto de no más de 350 palabras que sirva de contexto para el análisis de la próxima semana. Incluye la foto de métricas más reciente con números, la tendencia contra semanas anteriores, el estado de las campañas, las alertas vigentes y los pendientes. Indica la fecha de los datos que usaste. Si no había baseline, este es el primero.

${REGLAS}`;

export function reportUserPrompt(d: AdsReportData, audience: AdsAudience, ctx: AccountContext): string {
  const ids = blocksWithData(d, audience);
  return [
    `Redacta el informe ${audience === 'cliente' ? 'para el cliente' : 'para el administrador'} de la cuenta ${d.site.name}, periodo ${d.period.label} contra ${d.period.previousLabel}.`,
    `Bloques a escribir, en este orden: ${ids.join(', ')}.`,
    `Qué cubre cada bloque:\n${ADS_BLOCKS.filter((b) => ids.includes(b.id)).map((b) => `- ${b.id}: ${b.ask}`).join('\n')}`,
    `De tres a seis acciones.`,
    ctx.profile.trim() === '' ? '' : `PERFIL DE LA CUENTA:\n${ctx.profile.trim()}`,
    ctx.baseline === null ? '' : `BASELINE (contexto de semanas anteriores):\n${ctx.baseline}`,
    `DATOS (JSON):\n${JSON.stringify(aiPayload(d))}`,
  ].filter((x) => x !== '').join('\n\n');
}

export function weeklyUserPrompt(d: AdsReportData, ctx: AccountContext): string {
  return [
    `Análisis semanal de la cuenta ${d.site.name}. La semana es ultimos_7_dias (${d.week.range.start} a ${d.week.range.end}) contra los 7 previos; el periodo largo (${d.period.label}) da el contexto.`,
    ctx.profile.trim() === '' ? 'PERFIL DE LA CUENTA: (nadie lo ha escrito todavía)' : `PERFIL DE LA CUENTA:\n${ctx.profile.trim()}`,
    ctx.baseline === null ? 'BASELINE: (no hay; este es el primer análisis)' : `BASELINE ACTUAL:\n${ctx.baseline}`,
    `DATOS (JSON):\n${JSON.stringify(aiPayload(d))}`,
  ].join('\n\n');
}

// ── La llamada ──────────────────────────────────────────────────────────────

export interface AdsWriterOptions {
  model: string;
  effort: AdsEffort;
  /** Para las pruebas: un cliente con fetch falso. */
  client?: Anthropic;
}

export class AdsWriter {
  readonly #client: Anthropic;

  constructor(private readonly opts: AdsWriterOptions) {
    // La llave sale de ANTHROPIC_API_KEY. Tres reintentos sobre los dos del SDK:
    // esto corre de madrugada y nadie está mirando para volver a pedirlo.
    this.#client = opts.client ?? new Anthropic({ maxRetries: 3, timeout: 5 * 60_000 });
  }

  report(d: AdsReportData, audience: AdsAudience, ctx: AccountContext): Promise<WriteResult<ReportText>> {
    return this.#call(SYSTEM_BY_AUDIENCE[audience], reportUserPrompt(d, audience, ctx), ReportTextSchema);
  }

  weekly(d: AdsReportData, ctx: AccountContext): Promise<WriteResult<WeeklyText>> {
    return this.#call(SYSTEM_WEEKLY, weeklyUserPrompt(d, ctx), WeeklySchema);
  }

  async #call<T>(system: string, user: string, schema: z.ZodType<T>): Promise<WriteResult<T>> {
    const res = await this.#request(system, user, schema);

    if (res.stop_reason === 'refusal') {
      throw new AdsWriterError(`Claude declinó redactar el texto (${res.stop_details?.category ?? 'sin categoría'}).`);
    }
    if (res.stop_reason === 'max_tokens') {
      throw new AdsWriterError('La respuesta de Claude se cortó por longitud.');
    }
    if (res.parsed_output === null) {
      throw new AdsWriterError('Claude respondió, pero no con el formato esperado.');
    }
    return {
      content: res.parsed_output,
      model: res.model,
      inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
    };
  }

  async #request<T>(system: string, user: string, schema: z.ZodType<T>) {
    try {
      return await this.#send(system, user, schema);
    } catch (err) {
      // Los errores HTTP (429, 5xx, llave inválida) suben tal cual, con su
      // estado. Lo demás que lanza el SDK es que no pudo leer el JSON: una
      // respuesta truncada o fuera de formato.
      if (err instanceof Anthropic.APIError || !(err instanceof Anthropic.AnthropicError)) throw err;
      throw new AdsWriterError(`Claude respondió, pero no con el formato esperado: ${err.message}`);
    }
  }

  #send<T>(system: string, user: string, schema: z.ZodType<T>) {
    return this.#client.beta.messages.parse({
      model: this.opts.model,
      max_tokens: 16_000,
      // El system prompt es el mismo en cada cuenta: se cachea y solo se paga
      // completo la primera vez dentro de los cinco minutos.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: { effort: this.opts.effort, format: betaZodOutputFormat(schema) },
      // Si un clasificador de seguridad declina (raro con datos de anuncios,
      // pero posible), el servidor reintenta con el modelo que recomienda.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  }
}
