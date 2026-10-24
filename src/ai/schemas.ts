import { z } from "zod";

/**
 * AI natijasi faqat shu sxemalar orqali olinadi. Groq strict rejimi talablari:
 * barcha maydonlar `required`, `additionalProperties: false`, ixtiyoriy maydon — `null` bilan.
 */

export const INTENTS = [
  "create_task",
  "create_note",
  "create_reminder",
  "create_presentation",
  "update_item",
  "complete_task",
  "cancel_reminder",
  "list_items",
  "search_notes",
  "record_transaction",
  "finance_report",
  "clarify",
] as const;

export const CATEGORIES = ["work", "home", "study", "personal", "other"] as const;

export const FINANCE_CATEGORIES = [
  "food",
  "cafe",
  "transport",
  "housing",
  "utilities",
  "communication",
  "health",
  "education",
  "clothing",
  "household",
  "entertainment",
  "gifts",
  "business",
  "debt",
  "salary",
  "other",
] as const;
export type FinanceCategory = (typeof FINANCE_CATEGORIES)[number];

export const IntentSchema = z.enum(INTENTS);
export const CategorySchema = z.enum(CATEGORIES);

export const RecurrenceSchema = z.object({
  freq: z.enum(["daily", "weekly"]),
  interval: z.number().int(),
  by_weekday: z.array(z.number().int()),
  time: z.string(),
});

export const ListFilterSchema = z.object({
  range: z.enum(["today", "tomorrow", "this_week", "next_week", "overdue", "all"]),
  item_type: z.enum(["task", "note", "presentation", "reminder", "any"]),
  category: CategorySchema.nullable(),
  person_name: z.string().nullable(),
  note_kind: z.enum(["general", "absence"]).nullable(),
  query_text: z.string().nullable(),
  status: z.enum(["active", "done", "any"]),
});

export const OptionSchema = z.object({ label: z.string(), value: z.string() });

export const ActionSchema = z.object({
  intent: IntentSchema,
  category: CategorySchema.nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  person_name: z.string().nullable(),
  /** Mahalliy vaqt: "YYYY-MM-DDTHH:mm" yoki faqat sana "YYYY-MM-DD" */
  due_at: z.string().nullable(),
  event_at: z.string().nullable(),
  remind_at: z.string().nullable(),
  /** "ikki soatdan keyin" — xabar vaqtiga nisbatan daqiqalar */
  remind_in_minutes: z.number().int().nullable(),
  /** "darsdan yarim soat oldin" — event_at'ga nisbatan daqiqalar */
  remind_before_event_minutes: z.number().int().nullable(),
  timezone: z.string().nullable(),
  recurrence: RecurrenceSchema.nullable(),
  related_item_id: z.string().nullable(),
  candidate_item_ids: z.array(z.string()),
  link_to_action: z.number().int().nullable(),
  note_kind: z.enum(["general", "absence"]).nullable(),
  update_op: z.enum(["reschedule", "edit", "cancel"]).nullable(),
  location_trigger: z.string().nullable(),
  mentions_presentation: z.boolean(),
  presentation_topic: z.string().nullable(),
  presentation_language: z.enum(["uz", "ru", "en"]).nullable(),
  slide_count: z.number().int().nullable(),
  presentation_requirements: z.string().nullable(),
  reminder_text: z.string().nullable(),
  list_filter: ListFilterSchema.nullable(),
  /** Moliya: summa (asosiy birlikda, masalan 50000 so'm) */
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  transaction_kind: z.enum(["expense", "income"]).nullable(),
  finance_category: z.enum(FINANCE_CATEGORIES).nullable(),
  /** Tranzaksiya sanasi (mahalliy), null — hozir */
  occurred_at: z.string().nullable(),
  finance_period: z.enum(["today", "this_week", "this_month", "last_month"]).nullable(),
  /** Foydalanuvchi AYNAN aytgan hafta kuni / soat raqami — backend sanalarni shu bilan tekshiradi */
  time_hints: z.array(
    z.object({
      field: z.enum(["event_at", "due_at", "remind_at"]),
      weekday: z.number().int().nullable(),
      spoken_hour: z.number().int().nullable(),
      /** Shu vaqt uchun kun qismi so'zi aytilganmi (ertalab, kechqurun, утром, 20:00 kabi 24 soatlik format ham) */
      day_part_said: z.boolean(),
    }),
  ),
  missing_fields: z.array(z.string()),
  clarification_question: z.string().nullable(),
  clarification_options: z.array(OptionSchema),
});

export const ExtractionSchema = z.object({
  actions: z.array(ActionSchema),
  /** Faqat amal bo'lmagan suhbat uchun qisqa javob */
  reply: z.string().nullable(),
});

export const ResolutionSchema = z.object({
  /** Javob berilgan savolga tegishlimi */
  relates: z.boolean(),
  actions: z.array(ActionSchema),
});

export const SLIDE_LAYOUTS = ["bullets", "two_column", "table", "process", "conclusion"] as const;

export const OutlineSchema = z.object({
  title: z.string(),
  subtitle: z.string().nullable(),
  slides: z.array(
    z.object({
      title: z.string(),
      layout: z.enum(SLIDE_LAYOUTS),
      key_points: z.array(z.string()),
    }),
  ),
});

export const DeckSchema = z.object({
  title: z.string(),
  subtitle: z.string().nullable(),
  slides: z.array(
    z.object({
      layout: z.enum(SLIDE_LAYOUTS),
      title: z.string(),
      bullets: z.array(z.string()),
      left_title: z.string().nullable(),
      left_bullets: z.array(z.string()),
      right_title: z.string().nullable(),
      right_bullets: z.array(z.string()),
      table_headers: z.array(z.string()),
      table_rows: z.array(z.array(z.string())),
      steps: z.array(z.string()),
      notes: z.string().nullable(),
    }),
  ),
});

/** Fondagi tahlil: raqamlar backend'da hisoblanadi, AI faqat izoh yozadi */
export const FinanceInsightSchema = z.object({
  insights: z.array(z.string()),
});
export type FinanceInsight = z.infer<typeof FinanceInsightSchema>;

export type AiAction = z.infer<typeof ActionSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;
export type Resolution = z.infer<typeof ResolutionSchema>;
export type Outline = z.infer<typeof OutlineSchema>;
export type Deck = z.infer<typeof DeckSchema>;
export type DeckSlide = Deck["slides"][number];
export type ListFilter = z.infer<typeof ListFilterSchema>;

const STRIP_KEYS = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "format", "pattern", "minLength", "maxLength", "minItems", "maxItems", "default"]);

/** Zod → Groq strict json_schema: har bir obyekt yopiq, barcha maydonlar required. */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (STRIP_KEYS.has(k)) continue;
      out[k] = walk(v);
    }
    if (out.type === "object" && out.properties && typeof out.properties === "object") {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties as object);
    }
    return out;
  };
  return walk(raw) as Record<string, unknown>;
}

/** Testlar va fake provider uchun: barcha maydonlari bo'sh action. */
export function emptyAction(intent: AiAction["intent"], patch: Partial<AiAction> = {}): AiAction {
  return {
    intent,
    category: null,
    title: null,
    description: null,
    person_name: null,
    due_at: null,
    event_at: null,
    remind_at: null,
    remind_in_minutes: null,
    remind_before_event_minutes: null,
    timezone: null,
    recurrence: null,
    related_item_id: null,
    candidate_item_ids: [],
    link_to_action: null,
    note_kind: null,
    update_op: null,
    location_trigger: null,
    mentions_presentation: false,
    presentation_topic: null,
    presentation_language: null,
    slide_count: null,
    presentation_requirements: null,
    reminder_text: null,
    list_filter: null,
    amount: null,
    currency: null,
    transaction_kind: null,
    finance_category: null,
    occurred_at: null,
    finance_period: null,
    time_hints: [],
    missing_fields: [],
    clarification_question: null,
    clarification_options: [],
    ...patch,
  };
}
