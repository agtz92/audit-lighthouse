/**
 * Visibilidad en asistentes de IA: lo que dejó la auditoría (si pueden leer el
 * sitio) y lo que trajo GA4 (cuántas visitas mandan).
 *
 * Los tipos de la preparación reflejan el JSON que escribe
 * worker/src/audit/ai-readiness.ts en site_runs.ai_readiness.
 */

import { query } from './db';
import { addDays, pares, type DailyPair, type TrafficRange } from './traffic-queries';

export type BotRole = 'training' | 'search' | 'user';
export type FindingLevel = 'critical' | 'warning' | 'info';

export interface AiReadiness {
  checkedAt: string;
  homeUrl: string;
  robots: {
    status: number | null;
    error: string | null;
    bots: Array<{ token: string; vendor: string; role: BotRole; verdict: 'allowed' | 'partial' | 'blocked'; explicit: boolean }>;
  };
  baseline: { status: number | null; error: string | null; challenge: boolean };
  probes: Array<{ token: string; status: number | null; blocked: boolean; reason: string | null }>;
  llmsTxt: { status: number | null; present: boolean; valid: boolean; bytes: number; links: number };
  html: {
    words: number; title: string | null; description: string | null; canonical: string | null;
    lang: string | null; h1: number; jsonLdTypes: string[]; metaRobots: string | null;
  } | null;
  xRobotsTag: string | null;
  findings: Array<{ level: FindingLevel; message: string }>;
}

/** La revisión más reciente que llegó a hacerse. */
export async function fetchAiReadiness(siteId: string): Promise<AiReadiness | null> {
  const [r] = await query<{ ai_readiness: AiReadiness }>(`
    SELECT ai_readiness FROM site_runs
     WHERE site_id = $1 AND ai_readiness IS NOT NULL
     ORDER BY started_at DESC LIMIT 1
  `, [siteId]);
  return r?.ai_readiness ?? null;
}

export interface AiLabeledRow { key: string; sessions: number; engagedSessions: number; keyEvents: number }

export interface AiTraffic {
  /** Último día sincronizado; null si el sitio nunca trajo esta serie. */
  latest: string | null;
  sessions: number | null;
  prevSessions: number | null;
  engagedSessions: number | null;
  keyEvents: number | null;
  /** Fracción de todas las sesiones de GA4 en el mismo rango. */
  share: number | null;
  series: DailyPair[];
  /** Sesiones por asistente en el rango elegido. */
  assistants: Array<{ key: string; sessions: number; prev: number | null }>;
  /** Páginas de entrada, últimos 28 días: es el único desglose guardado. */
  landing: AiLabeledRow[];
  landingRange: { start: string; end: string } | null;
}

export async function fetchAiTraffic(siteId: string, days: TrafficRange): Promise<AiTraffic> {
  const [a] = await query<{ last: string | null; first: string | null }>(`
    SELECT to_char(max(date), 'YYYY-MM-DD') AS last, to_char(min(date), 'YYYY-MM-DD') AS first
      FROM ga_ai_daily WHERE site_id = $1
  `, [siteId]);
  const latest = a?.last ?? null;
  const first = a?.first ?? null;

  const [bd] = await query<{ rows: unknown; s: string; e: string }>(`
    SELECT rows, to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e
      FROM analytics_breakdowns WHERE site_id = $1 AND period = 'last28' AND kind = 'ga_ai_landing'
  `, [siteId]);
  const landing = Array.isArray(bd?.rows) ? (bd.rows as AiLabeledRow[]) : [];
  const landingRange = bd === undefined ? null : { start: bd.s, end: bd.e };

  if (latest === null) {
    return {
      latest, sessions: null, prevSessions: null, engagedSessions: null, keyEvents: null, share: null,
      series: [], assistants: [], landing, landingRange,
    };
  }

  const rows = await query<{ d: string; sessions: number; engaged_sessions: number; key_events: number; by_assistant: Record<string, number> }>(`
    SELECT to_char(date, 'YYYY-MM-DD') AS d, sessions, engaged_sessions, key_events, by_assistant
      FROM ga_ai_daily WHERE site_id = $1 AND date > $2::date - 2 * $3::int ORDER BY date
  `, [siteId, latest, days]);

  const desde = addDays(latest, 1 - days);
  const desdePrev = addDays(latest, 1 - 2 * days);
  const actual = rows.filter((r) => r.d >= desde);
  const previo = rows.filter((r) => r.d < desde);
  // El anterior solo cuenta si la historia lo cubre completo.
  const prevCompleto = first !== null && first <= desdePrev;

  const porAsistente = (rs: typeof rows): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rs) for (const [k, v] of Object.entries(r.by_assistant)) m.set(k, (m.get(k) ?? 0) + v);
    return m;
  };
  const act = porAsistente(actual);
  const prev = porAsistente(previo);
  const assistants = [...new Set([...act.keys(), ...prev.keys()])]
    .map((key) => ({ key, sessions: act.get(key) ?? 0, prev: prevCompleto ? prev.get(key) ?? 0 : null }))
    .filter((x) => x.sessions > 0 || (x.prev ?? 0) > 0)
    .sort((x, y) => y.sessions - x.sessions);

  const sessions = actual.reduce((s, r) => s + r.sessions, 0);
  const [tot] = await query<{ total: number | null }>(`
    SELECT sum(sessions) AS total FROM ga_daily WHERE site_id = $1 AND date BETWEEN $2 AND $3
  `, [siteId, desde, latest]);
  const total = tot?.total ?? null;

  return {
    latest,
    sessions,
    prevSessions: prevCompleto ? previo.reduce((s, r) => s + r.sessions, 0) : null,
    engagedSessions: actual.reduce((s, r) => s + r.engaged_sessions, 0),
    keyEvents: actual.reduce((s, r) => s + r.key_events, 0),
    share: total === null || total === 0 ? null : sessions / total,
    series: pares(new Map(rows.map((r) => [r.d, r.sessions])), latest, days, first),
    assistants,
    landing,
    landingRange,
  };
}

/** Sesiones desde asistentes por sitio, para el panorama de tráfico. */
export async function fetchAiSessionsBySite(days: TrafficRange): Promise<Map<string, { sessions: number; prev: number | null }>> {
  const rows = await query<{ site_id: string; sessions: number | null; prev: number | null; first: string; anchor: string }>(`
    WITH a AS (SELECT site_id, max(date) AS anchor, min(date) AS first FROM ga_ai_daily GROUP BY site_id)
    SELECT d.site_id,
           sum(d.sessions) FILTER (WHERE d.date >  a.anchor - $1::int) AS sessions,
           CASE WHEN a.first <= a.anchor - (2 * $1::int - 1)
                THEN sum(d.sessions) FILTER (WHERE d.date <= a.anchor - $1::int) END AS prev,
           to_char(a.first, 'YYYY-MM-DD') AS first, to_char(a.anchor, 'YYYY-MM-DD') AS anchor
      FROM ga_ai_daily d JOIN a USING (site_id)
     WHERE d.date > a.anchor - 2 * $1::int
     GROUP BY d.site_id, a.first, a.anchor
  `, [days]);
  return new Map(rows.map((r) => [r.site_id, { sessions: r.sessions ?? 0, prev: r.prev }]));
}
